import * as vscode from 'vscode';

export class BspDebugSessions {
    private sessions = new Map<string, vscode.DebugSession>();
    private subscriptions: vscode.Disposable[] = [];

    constructor(private owner: string) {}

    configuration(target: string): { bspOwner: string; bspTarget: string } {
        this.observe();
        return { bspOwner: this.owner, bspTarget: target };
    }

    async stop(target: string, report: (message: string) => void): Promise<void> {
        this.observe();
        const active = vscode.debug.activeDebugSession;
        if (active && this.matches(active, target)) { this.sessions.set(active.id, active); }
        for (const session of this.sessions.values()) {
            if (!this.matches(session, target)) { continue; }
            report('Stopping the previous debug session before running the target');
            await this.disconnect(session);
            this.sessions.delete(session.id);
        }
    }

    dispose(): void {
        for (const subscription of this.subscriptions) { subscription.dispose(); }
        this.subscriptions = [];
        this.sessions.clear();
    }

    private matches(session: vscode.DebugSession, target: string): boolean {
        if (session.type !== 'bsp-debug') { return false; }
        const config = session.configuration;
        if (config.bspOwner !== undefined) {
            return config.bspOwner === this.owner && config.bspTarget === target;
        }
        return session.name === `Debug ${target}`;
    }

    private observe(): void {
        if (this.subscriptions.length) { return; }
        this.subscriptions.push(
            vscode.debug.onDidStartDebugSession(session => {
                if (session.configuration.bspOwner === this.owner) { this.sessions.set(session.id, session); }
            }),
            vscode.debug.onDidTerminateDebugSession(session => this.sessions.delete(session.id))
        );
    }

    private disconnect(session: vscode.DebugSession): Promise<void> {
        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = (error?: Error) => {
                if (finished) { return; }
                finished = true;
                clearTimeout(timer);
                subscription.dispose();
                if (error) { reject(error); } else { resolve(); }
            };
            const subscription = vscode.debug.onDidTerminateDebugSession(ended => {
                if (ended.id === session.id) { finish(); }
            });
            const timer = setTimeout(() => finish(new Error(
                'The previous debug session did not stop. Stop it in Run and Debug, then retry.'
            )), 15000);
            // An attach session must terminate its app before a new installation.
            void session.customRequest('disconnect', { terminateDebuggee: true }).then(
                () => { if (!finished) { void vscode.debug.stopDebugging(session).then(undefined, finish); } },
                error => finish(error)
            );
        });
    }
}
