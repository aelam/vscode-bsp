const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { BspStdio } = require('../out/bspStdio');

function frame(value) {
    const body = Buffer.from(JSON.stringify(value));
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}
async function filter(chunks) {
    const logs = [], output = [];
    const stream = new BspStdio(message => logs.push(message));
    stream.on('data', data => output.push(data));
    const done = once(stream, 'end');
    for (const chunk of chunks) { stream.write(chunk); }
    stream.end(); await done;
    return { logs, output: Buffer.concat(output) };
}

test('separates stdout noise from fragmented messages without inspecting JSON payloads', async () => {
    const first = frame({ jsonrpc: '2.0', id: 1, result: '你好\nContent-Length: 100\r\n\r\n' });
    const second = frame({ jsonrpc: '2.0', id: 2, result: { statusCode: 1 } });
    const input = Buffer.concat([Buffer.from('Starting\n'), first, Buffer.from('Hello, 世界!'), second, Buffer.from('Done\n')]);
    for (const chunkSize of [1, 2, 7, 31, input.length]) {
        const chunks = [];
        for (let i = 0; i < input.length; i += chunkSize) { chunks.push(input.subarray(i, i + chunkSize)); }
        const result = await filter(chunks);
        assert.deepEqual(result.output, Buffer.concat([first, second]));
        assert.deepEqual(result.logs, ['Starting', 'Hello, 世界!', 'Done']);
    }
});

test('passes standard headers and consecutive messages unchanged', async () => {
    const body = Buffer.from('{"id":1,"result":"ok"}');
    const input = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`), body, frame({ id: 2, result: null })]);
    const result = await filter([input]);
    assert.deepEqual(result.output, input);
    assert.deepEqual(result.logs, []);
});

test('rejects incomplete frames and invalid sizes instead of waiting forever', async () => {
    for (const text of [
        'Content-Length: 20\r\n\r\n{}',
        'Content-Length: -1\r\n\r\n',
        'Content-Length: 67108865\r\n\r\n',
        'Content-Length: x\r\n\r\n',
        'Content-Length: 10',
        'Content-Length: ' + '0'.repeat(9000)
    ]) { await assert.rejects(filter([Buffer.from(text)]), /BSP/); }
});

test('bounds buffering for long unframed output and resumes at the next frame', async () => {
    const message = frame({ id: 1, result: null });
    const result = await filter([Buffer.alloc(100000, 120), message]);
    assert.equal(result.logs.join('').length, 100000);
    assert.deepEqual(result.output, message);
});


test('preserves UTF-8 when splitting long unframed output', async () => {
    const text = '测试'.repeat(20000);
    const message = frame({ id: 1, result: null });
    const result = await filter([Buffer.from(text), message]);
    assert.equal(result.logs.join(''), text);
    assert.deepEqual(result.output, message);
});


test('accepts Content-Type before Content-Length', async () => {
    const message = Buffer.concat([Buffer.from('Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n'), frame({ id: 1, result: null })]);
    const result = await filter([message]);
    assert.deepEqual(result.output, message);
    assert.deepEqual(result.logs, []);
});
