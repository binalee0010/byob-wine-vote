import initialSchema from '../migrations/0001_initial.sql';
import candidateDescription from '../migrations/0004_candidate_description.sql';
import participantEntries from '../migrations/0006_participant_entries.sql';

export type Workspace = { slug: string; namespace: string | null; memberId?: string };

const namespacePattern = /^m_[a-f0-9]{32}$/;
const objectNames = new Set(Array.from(`${initialSchema}\n${participantEntries}`.matchAll(/CREATE\s+(?:TABLE|INDEX|TRIGGER)\s+(\w+)/gi), match => match[1].toLowerCase()));
// SQL values and comments must stay literal, including JSON paths and the BYOB activity ID.
const sqlTokens = /'(?:''|[^'])*'|--[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_]*/g;

function checkWorkspace(workspace: Workspace) {
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(workspace.slug) || (workspace.namespace !== null && !namespacePattern.test(workspace.namespace))
    || (workspace.memberId !== undefined && workspace.memberId !== 'owner' && !/^[a-f0-9]{32}$/.test(workspace.memberId))) {
    throw new Error('Invalid internal workspace');
  }
}

export function workspaceSql(sql: string, namespace: string) {
  if (!namespacePattern.test(namespace)) throw new Error('Invalid internal workspace namespace');
  return sql.replace(sqlTokens, token => {
    const quoted = token[0] === '"' || token[0] === '`' || token[0] === '[';
    const name = quoted ? token.slice(1, -1) : token;
    return objectNames.has(name.toLowerCase()) ? (quoted ? `${token[0]}${namespace}_${name}${token.at(-1)}` : `${namespace}_${token}`) : token;
  });
}

export function workspaceDatabase(db: D1Database, workspace: Workspace): D1Database {
  checkWorkspace(workspace);
  const namespace = workspace.namespace;
  if (!namespace) return db;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => target.prepare(workspaceSql(sql, namespace));
      if (property === 'batch') return target.batch.bind(target);
      throw new Error('Unsupported workspace database operation');
    }
  });
}

export async function ensureWorkspace(env: { DB: D1Database }, workspace: Workspace) {
  checkWorkspace(workspace);
  if (!workspace.namespace) return;
  const table = `${workspace.namespace}_event`;
  const exists = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(table).first();
  const descriptionReady = async () => /\bdescription\b/i.test((await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").bind(`${workspace.namespace}_candidates`).first<{sql:string}>())?.sql ?? '');
  const entriesReady = async () => Boolean(await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(`${workspace.namespace}_participant_entries`).first());
  const descriptionExists = exists && await descriptionReady(), entriesExist = exists && await entriesReady();
  if (descriptionExists && entriesExist) return;
  const statements = `${exists ? '' : initialSchema}\n${descriptionExists ? '' : candidateDescription}\n${entriesExist ? '' : participantEntries}`.split(/;\s*(?:\r?\n|$)/).map(statement => statement.trim()).filter(statement => statement && !/^PRAGMA\b/i.test(statement));
  // D1 batches are atomic; IF NOT EXISTS and seed conflicts also allow concurrent first access.
  try {
    await env.DB.batch(statements.map(statement => env.DB.prepare(workspaceSql(statement
      .replace(/^CREATE (TABLE|INDEX|TRIGGER)\b/i, 'CREATE $1 IF NOT EXISTS')
      .replace(/^INSERT INTO\b/i, 'INSERT OR IGNORE INTO'), workspace.namespace!))));
  } catch (error) {
    // Another first request may have completed the same atomic schema upgrade.
    if (!await descriptionReady() || !await entriesReady()) throw error;
  }
}

export function workspacePhotoKey(workspace: Workspace | undefined, key: string) {
  return workspace?.namespace ? `members/${workspace.namespace}/${key}` : key;
}

function workspacePhotos(bucket: R2Bucket, workspace: Workspace): R2Bucket {
  const prefix = workspace.namespace ? `members/${workspace.namespace}/` : null;
  const check = (key: string) => {
    if (prefix ? !key.startsWith(prefix) : key.startsWith('members/')) throw new Error('Photo outside workspace');
    return key;
  };
  return new Proxy(bucket, {
    get(target, property) {
      if (property === 'get') return (key: string, options?: R2GetOptions) => target.get(check(key), options);
      if (property === 'put') return (key: string, value: Parameters<R2Bucket['put']>[1], options?: R2PutOptions) => target.put(check(key), value, options);
      if (property === 'delete') return (key: string | string[]) => target.delete(Array.isArray(key) ? key.map(check) : check(key));
      throw new Error('Unsupported workspace photo operation');
    }
  });
}

export function workspaceEnv<T extends { DB: D1Database; PHOTOS: R2Bucket; ADMIN_SESSION_COOKIE?: string; PARTICIPANT_SESSION_COOKIE?: string }>(env: T, workspace: Workspace): T & { WORKSPACE: Workspace } {
  checkWorkspace(workspace);
  const suffix = workspace.namespace ?? 'owner';
  return { ...env, WORKSPACE: workspace, DB: workspaceDatabase(env.DB, workspace), PHOTOS: workspacePhotos(env.PHOTOS, workspace),
    ADMIN_SESSION_COOKIE: workspace.namespace ? `__Host-byob_admin_${suffix}` : env.ADMIN_SESSION_COOKIE,
    PARTICIPANT_SESSION_COOKIE: workspace.namespace ? `__Host-byob_participant_${suffix}` : env.PARTICIPANT_SESSION_COOKIE };
}
