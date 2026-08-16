const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Server, utils } = require('ssh2');

function hostKey(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const generated = utils.generateKeyPairSync('ed25519');
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, generated.private, { mode: 0o600, flag: 'wx' });
    try { fs.linkSync(temporary, filePath); return generated.private; }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; return fs.readFileSync(filePath, 'utf8'); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
}

function parseGitCommand(command) {
  const match = /^(git-upload-pack|git-receive-pack)\s+(['"])([^'"\0\r\n]+)\2$/.exec(String(command || ''));
  if (!match) return null;
  const repository = match[3].replace(/^\/+/, '');
  const pathMatch = /^([a-z0-9._-]+)\/([a-z0-9._-]+)\.git$/.exec(repository);
  return pathMatch ? { service: match[1], namespace: pathMatch[1], slug: pathMatch[2] } : null;
}

class GitSshServer {
  constructor({ dataPath, projects, repositories, auth, keys, gitExecutable = 'git' }) {
    this.dataPath = path.resolve(dataPath);
    this.projects = projects;
    this.repositories = repositories;
    this.auth = auth;
    this.keys = keys;
    this.gitExecutable = gitExecutable;
    this.server = null;
  }

  listen(port, host = '127.0.0.1', callback) {
    if (this.server) throw new Error('SSH server is already running');
    this.server = new Server({ hostKeys: [hostKey(path.join(this.dataPath, 'ssh', 'host_ed25519'))], ident: 'KitsuneGIT' }, client => {
      let actor = null;
      client.on('authentication', context => {
        if (context.method !== 'publickey' || context.username !== 'git') return context.reject(['publickey']);
        const signature = context.signature ? { blob: context.blob, value: context.signature, hashAlgo: context.hashAlgo } : null;
        const authenticated = this.keys.authenticate(context.key, signature);
        if (!authenticated) return context.reject(['publickey']);
        actor = authenticated;
        context.accept();
      });
      client.on('ready', () => client.on('session', accept => {
        const session = accept();
        session.on('exec', (acceptExec, rejectExec, info) => {
          const parsed = parseGitCommand(info.command);
          if (!parsed || !actor) return rejectExec();
          let project;
          try {
            project = this.projects.getByPath(parsed.namespace, parsed.slug);
            this.auth.requireProject(project.id, actor, parsed.service === 'git-receive-pack' ? 'developer' : 'guest');
          } catch { return rejectExec(); }
          const stream = acceptExec();
          const child = spawn(this.gitExecutable, [parsed.service.slice(4), this.repositories.pathFor(project)], {
            shell: false,
            windowsHide: true,
            env: {
              ...process.env,
              GIT_CONFIG_NOSYSTEM: '1',
              KITSUNE_DATA_FILE: this.auth.store.filePath,
              KITSUNE_PROJECT_ID: project.id,
              KITSUNE_ACTOR_ID: actor.id,
              KITSUNE_ACTOR_ADMIN: actor.admin ? '1' : '0',
              KITSUNE_DEFAULT_STORAGE_LIMIT_BYTES: String(project.storageLimitBytes || 0)
            }
          });
          stream.pipe(child.stdin);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          child.once('error', error => { stream.stderr.write(`${error.message}\n`); stream.exit(1); stream.end(); });
          child.once('close', code => { stream.exit(code || 0); stream.end(); });
          stream.once('close', () => { if (!child.killed) child.kill(); });
        });
      }));
      client.on('error', () => {});
    });
    this.server.on('error', error => { if (this.server.listenerCount('kitsune-error')) this.server.emit('kitsune-error', error); else console.error(`KitsuneGIT SSH: ${error.message}`); });
    return this.server.listen(port, host, callback);
  }

  address() { return this.server?.address(); }
  close(callback) { if (this.server) this.server.close(callback); else callback?.(); }
}

module.exports = { GitSshServer, parseGitCommand, hostKey };
