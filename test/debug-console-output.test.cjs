const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DebugConsoleOutput } = require('../out/debugConsoleOutput');

async function fixture(t, clock) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bsp-console-'));
    const messages = [];
    const output = new DebugConsoleOutput(message => messages.push(message), directory, clock);
    t.after(async () => {
        output.dispose();
        await output.archive.settled();
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { output, messages, directory };
}

test('ordinary messages and console metadata keep their DAP semantics', async t => {
    const { output, messages, directory } = await fixture(t);
    const inputs = [
        { type: 'event', event: 'output', body: { output: 'hello\n', category: 'stderr', source: { path: '/tmp/a.swift' }, line: 2 } },
        { type: 'event', event: 'output', body: { output: '', category: 'console', data: { detail: 'metadata' } } },
        { type: 'response', command: 'evaluate', request_seq: 12, success: true, body: { result: '42', variablesReference: 0 } },
        { type: 'response', command: 'evaluate', request_seq: 13, success: false, message: 'No such variable', body: {} },
        { type: 'response', command: 'evaluate', request_seq: 15, success: false, message: 'Failure', body: { error: { id: 1 } } },
        { type: 'request', command: 'runInTerminal', seq: 14, arguments: { args: ['/bin/echo', 'x'] } },
        { type: 'event', event: 'output', body: { category: 'telemetry', output: 'x'.repeat(20000) } },
        { type: 'event', event: 'stopped', body: { threadId: 1 } }
    ];
    for (const message of inputs) { output.accept(message); }
    assert.deepEqual(messages, inputs);
    assert.deepEqual(await fs.readdir(directory), []);
});

test('large console diagnostics retain a preview and save the original text', async t => {
    const { output, messages } = await fixture(t);
    const text = 'first diagnostic\n' + 'error: missing module\n'.repeat(20000) + 'last diagnostic\n';
    output.accept({ type: 'event', event: 'output', body: { category: 'console', output: text, source: { path: '/tmp/file' } } });
    assert.ok(messages[0].body.output.length <= 8192);
    assert.ok(messages[0].body.output.startsWith('first diagnostic'));
    assert.ok(messages[0].body.output.endsWith('last diagnostic\n'));
    assert.ok(messages[0].body.output.split('\n').length <= 203);
    assert.equal(messages[0].body.source.path, '/tmp/file');
    assert.ok(messages.some(message => message.body.output.includes(output.archive.file)));
    await output.archive.settled();
    assert.ok((await fs.readFile(output.archive.file, 'utf8')).includes(text));
});

test('a failed evaluate response keeps its identity and bounds every displayed error field', async t => {
    const { output, messages } = await fixture(t);
    const text = 'module diagnostics\n'.repeat(5000) + 'cannot find variable in scope';
    const original = { type: 'response', seq: 55, request_seq: 9, command: 'evaluate', success: false,
        message: text, body: { error: { id: 17, format: text, showUser: true, variables: { detail: text } } } };
    output.accept(original);
    const response = messages.find(message => message.type === 'response');
    assert.equal(response.request_seq, 9);
    assert.equal(response.seq, 55);
    assert.equal(response.success, false);
    assert.equal(response.body.error.id, 17);
    assert.equal(response.body.error.showUser, true);
    for (const value of [response.message, response.body.error.format, response.body.error.variables.detail]) {
        assert.ok(value.length < 9000);
        assert.ok(value.includes('cannot find variable in scope'));
    }
    assert.equal(original.message, text);
    assert.equal(Object.hasOwn(response.body, 'result'), false);
    await output.archive.settled();
    assert.ok((await fs.readFile(output.archive.file, 'utf8')).includes(text));
});

test('large successful evaluations keep their variable references and Unicode boundaries', async t => {
    const { output, messages } = await fixture(t);
    const text = '😀漢字'.repeat(10000);
    output.accept({ type: 'response', request_seq: 1, command: 'evaluate', success: true,
        body: { result: text, type: 'Array', variablesReference: 42, namedVariables: 5, memoryReference: '0x1234' } });
    const response = messages.find(message => message.type === 'response');
    assert.equal(response.body.variablesReference, 42);
    assert.equal(response.body.memoryReference, '0x1234');
    assert.equal(response.body.namedVariables, 5);
    assert.ok(response.body.result.length < 9000);
    assert.equal(response.body.result.isWellFormed(), true);
});

test('many short lines are limited even when the text is small', async t => {
    const { output, messages } = await fixture(t);
    output.accept({ type: 'response', command: 'evaluate', body: { result: '\n'.repeat(4000), variablesReference: 0 } });
    const response = messages.find(message => message.type === 'response');
    assert.ok(response.body.result.split('\n').length < 210);
});

test('a burst is bounded while responses and later output remain deliverable', async t => {
    let now = 0;
    const { output, messages } = await fixture(t, () => now);
    for (let index = 0; index < 20000; index++) {
        output.accept({ type: 'event', event: 'output', body: { category: 'console', output: `diagnostic ${index}\n` } });
    }
    assert.ok(messages.length <= 66);
    output.accept({ type: 'response', command: 'evaluate', request_seq: 100, success: false, message: 'No such variable' });
    output.accept({ type: 'response', command: 'continue', request_seq: 101, success: true });
    assert.equal(messages.at(-1).command, 'continue');
    now = 251;
    output.accept({ type: 'event', event: 'output', body: { category: 'console', output: 'next command\n' } });
    assert.equal(messages.at(-1).body.output, 'next command\n');
    await output.archive.settled();
    const saved = await fs.readFile(output.archive.file, 'utf8');
    assert.ok(saved.includes('diagnostic 19999\n'));
    assert.ok(saved.includes('diagnostic 64\n'));
});

test('output groups and variable handles survive an exhausted text budget', async t => {
    const { output, messages } = await fixture(t, () => 0);
    for (let index = 0; index < 65; index++) {
        output.accept({ type: 'event', event: 'output', body: { output: 'line\n' } });
    }
    output.accept({ type: 'event', event: 'output', body: { group: 'start', output: 'group', variablesReference: 4 } });
    output.accept({ type: 'event', event: 'output', body: { group: 'end', output: '' } });
    assert.equal(messages.at(-2).body.variablesReference, 4);
    assert.equal(messages.at(-2).body.group, 'start');
    assert.equal(messages.at(-1).body.group, 'end');
});

test('archive failures do not block the response and produce one clear notice', async t => {
    const { output, messages, directory } = await fixture(t);
    await fs.rm(directory, { recursive: true });
    await fs.writeFile(directory, 'not a directory');
    const request = { type: 'response', command: 'evaluate', request_seq: 5, success: false, message: 'x'.repeat(20000) };
    output.accept(request);
    assert.equal(messages.find(message => message.type === 'response').request_seq, 5);
    await output.archive.settled();
    assert.equal(messages.filter(message => message.body?.output?.includes('Could not save')).length, 1);
    output.accept(request);
    assert.ok(messages.at(-1).message.includes('could not be saved'));
    assert.equal(messages.some(message => message.body?.output?.includes('exceeded the local log limit')), false);
});

test('very large results also bound queued archive data and disclose incomplete logs', async t => {
    const { output, messages } = await fixture(t);
    output.accept({ type: 'response', command: 'evaluate', request_seq: 8, success: true,
        body: { result: 'x'.repeat(10 * 1024 * 1024), variablesReference: 0 } });
    assert.ok(messages.find(message => message.type === 'response').body.result.length < 9000);
    assert.ok(messages.some(message => message.body?.output?.includes('saved text is incomplete')));
    await output.archive.settled();
    const saved = await fs.readFile(output.archive.file, 'utf8');
    assert.ok(Buffer.byteLength(saved) <= 8 * 1024 * 1024);
    assert.ok(saved.includes('Local log limit reached'));
});
