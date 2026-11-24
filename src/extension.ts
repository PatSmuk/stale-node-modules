import * as path from 'node:path';
import * as vscode from 'vscode';
import { checkRoot, findInstallRoots, fingerprint, hasNodeModules, Problem, summarize } from './detect';

// The slice of the built-in git extension's API (extensions/git/src/api/git.d.ts) used here.
interface Branch {
  readonly name?: string;
  readonly commit?: string;
}
interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly HEAD: Branch | undefined; readonly onDidChange: vscode.Event<void> };
}
interface GitAPI {
  /** The git executable VS Code found or the user set with `git.path`. */
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}
interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitAPI;
}

export interface Notice {
  repoRoot: string;
  message: string;
  roots: { dir: string; problems: Problem[] }[];
}

/** Returned from activate(); used by the integration test. */
export interface ReminderApi {
  onDidNotify: vscode.Event<Notice>;
  watchedRepositories(): string[];
}

/** HEAD moves several times during a checkout or rebase; wait for it to settle. */
const SETTLE_MS = 1000;

export function activate(context: vscode.ExtensionContext): ReminderApi {
  const log = vscode.window.createOutputChannel('Stale node_modules', { log: true });
  const notify = new vscode.EventEmitter<Notice>();
  const watchers = new Map<string, RepoWatcher>();
  context.subscriptions.push(log, notify, {
    dispose: () => {
      for (const w of watchers.values()) w.dispose();
      watchers.clear();
    },
  });

  const add = (repo: Repository, gitPath: string) => {
    const key = repo.rootUri.fsPath;
    if (!watchers.has(key)) watchers.set(key, new RepoWatcher(repo, gitPath, log, notify));
  };
  const remove = (repo: Repository) => {
    const key = repo.rootUri.fsPath;
    watchers.get(key)?.dispose();
    watchers.delete(key);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('staleNodeModules.checkNow', async () => {
      if (watchers.size === 0) {
        void vscode.window.showInformationMessage('Stale node_modules: no git repositories are open.');
        return;
      }
      const found = await Promise.all([...watchers.values()].map((w) => w.check('Manual check', true)));
      if (!found.includes(true)) void vscode.window.showInformationMessage('node_modules is up to date.');
    }),
  );

  connectGit(context, add, remove).catch((err) => log.error('Could not connect to the git extension:', err));

  return { onDidNotify: notify.event, watchedRepositories: () => [...watchers.keys()] };
}

export function deactivate(): void {}

async function connectGit(
  context: vscode.ExtensionContext,
  add: (repo: Repository, gitPath: string) => void,
  remove: (repo: Repository) => void,
): Promise<void> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) throw new Error('vscode.git is not installed');
  const git = ext.isActive ? ext.exports : await ext.activate();
  const attach = () => {
    const api = git.getAPI(1);
    const addRepo = (repo: Repository) => add(repo, api.git.path);
    api.repositories.forEach(addRepo);
    context.subscriptions.push(api.onDidOpenRepository(addRepo), api.onDidCloseRepository(remove));
  };
  if (git.enabled) {
    attach();
    return;
  }
  const sub = git.onDidChangeEnablement((enabled) => {
    if (!enabled) return;
    sub.dispose();
    attach();
  });
  context.subscriptions.push(sub);
}

class RepoWatcher implements vscode.Disposable {
  private readonly root: string;
  private head: Branch | undefined;
  private movedFrom: Branch | undefined;
  private timer: NodeJS.Timeout | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** install dir -> fingerprint of the problems last reported there */
  private readonly reported = new Map<string, string>();
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly repo: Repository,
    private readonly gitPath: string,
    private readonly log: vscode.LogOutputChannel,
    private readonly notify: vscode.EventEmitter<Notice>,
  ) {
    this.root = repo.rootUri.fsPath;
    this.head = snapshot(repo.state.HEAD);
    this.sub = repo.state.onDidChange(() => this.onStateChange());
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.sub.dispose();
  }

  private onStateChange(): void {
    const next = snapshot(this.repo.state.HEAD);
    if (!next?.commit) return;
    if (!this.head?.commit) {
      this.head = next; // first time the git extension reports HEAD: just remember it
      return;
    }
    if (next.commit === this.head.commit && next.name === this.head.name) return;
    this.movedFrom ??= this.head;
    this.head = next;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const from = this.movedFrom!;
      this.movedFrom = undefined;
      void this.check(describeMove(from, next), false);
    }, SETTLE_MS);
  }

  /** Resolves true if anything is out of date. Checks run one at a time per repo. */
  check(reason: string, manual: boolean): Promise<boolean> {
    const run = this.queue.then(() => this.runCheck(reason, manual));
    this.queue = run.catch(() => undefined);
    return run.catch((err) => {
      this.log.error(`Check failed in ${this.root}:`, err);
      return false;
    });
  }

  private async runCheck(reason: string, manual: boolean): Promise<boolean> {
    const roots = await findInstallRoots(this.root, this.gitPath);
    const stale: Notice['roots'] = [];
    let alreadyReported = 0;
    for (const root of roots) {
      if (!(await hasNodeModules(root.dir))) continue; // never installed here; nothing to go stale
      const problems = await checkRoot(root);
      if (problems.length === 0) {
        this.reported.delete(root.dir);
        continue;
      }
      const print = fingerprint(problems);
      const seen = this.reported.get(root.dir) === print;
      this.reported.set(root.dir, print);
      if (seen && !manual) {
        alreadyReported++;
        continue;
      }
      stale.push({ dir: root.dir, problems });
    }

    this.log.info(
      `${reason} (${this.root}): ${roots.length} package root(s), ${stale.length} newly out of date` +
        (alreadyReported ? `, ${alreadyReported} already reported` : ''),
    );
    if (stale.length === 0) return alreadyReported > 0;

    for (const { dir, problems } of stale) {
      for (const p of problems.slice(0, 200)) this.log.warn(`${this.label(dir)}: ${p.detail}`);
      if (problems.length > 200) this.log.warn(`${this.label(dir)}: …and ${problems.length - 200} more`);
    }
    const where = stale.map(({ dir, problems }) => `${this.label(dir)} (${summarize(problems)})`).join('; ');
    const message = `${reason}: node_modules is out of date in ${where}.`;
    this.notify.fire({ repoRoot: this.root, message, roots: stale });
    void this.prompt(message, stale.map((s) => s.dir));
    return true;
  }

  private async prompt(message: string, dirs: string[]): Promise<void> {
    const command = vscode.workspace.getConfiguration('staleNodeModules').get<string>('installCommand') || 'npm install';
    const run = `Run ${command}`;
    const details = 'Show Details';
    const choice = await vscode.window.showWarningMessage(message, run, details);
    if (choice === run) {
      for (const dir of dirs) {
        const terminal = vscode.window.createTerminal({ name: `${command}: ${this.label(dir)}`, cwd: dir });
        terminal.show();
        terminal.sendText(command);
      }
    } else if (choice === details) {
      this.log.show(true);
    }
  }

  /** "my-app" for the repo root, "my-app/web" for a subdirectory. */
  private label(dir: string): string {
    const rel = path.relative(this.root, dir);
    const repo = path.basename(this.root);
    return rel ? `${repo}/${rel.split(path.sep).join('/')}` : repo;
  }
}

function snapshot(head: Branch | undefined): Branch | undefined {
  return head && { name: head.name, commit: head.commit };
}

function describeMove(from: Branch, to: Branch): string {
  const short = to.commit?.slice(0, 7) ?? '?';
  if (to.name && to.name !== from.name) return `Switched to ${to.name}`;
  if (to.name) return `${to.name} moved to ${short}`;
  return `Checked out ${short}`;
}
