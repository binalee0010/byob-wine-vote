import initialSchema from '../migrations/0001_initial.sql';
import candidateDescription from '../migrations/0004_candidate_description.sql';
import participantEntries from '../migrations/0006_participant_entries.sql';
import eventMemo from '../migrations/0008_event_memo.sql';
import resultAudience from '../migrations/0009_result_audience.sql';
import candidatePhotoReplace from '../migrations/0011_candidate_photo_replace.sql';
import candidateOrder from '../migrations/0013_candidate_order.sql';
import { publicAliasPattern } from './public-links';

export type Workspace = { slug: string; namespace: string | null; memberId?: string; publicSlug?: string; publicAlias?: string };

export async function workspaceDeleted(env: {DB:D1Database}, workspace:Workspace) {
  return Boolean(await env.DB.prepare('SELECT 1 FROM member_polls WHERE slug=? AND deleted_at IS NOT NULL').bind(workspace.slug).first());
}

const namespacePattern = /^m_[a-f0-9]{32}$/;
const objectNames = new Set(Array.from(`${initialSchema}\n${participantEntries}\n${resultAudience}\n${candidatePhotoReplace}\n${candidateOrder}`.matchAll(/CREATE\s+(?:TABLE|INDEX|TRIGGER)\s+(\w+)/gi), match => match[1].toLowerCase()));
// SQL values and comments must stay literal, including JSON paths and the BYOB activity ID.
const sqlTokens = /'(?:''|[^'])*'|--[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_]*/g;

function checkWorkspace(workspace: Workspace) {
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(workspace.slug) || (workspace.namespace !== null && !namespacePattern.test(workspace.namespace))
    || (workspace.publicSlug !== undefined && !/^[a-f0-9]{32}$/.test(workspace.publicSlug))
    || (workspace.publicAlias !== undefined && !publicAliasPattern.test(workspace.publicAlias))
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
  const memoReady = async () => /\bmemo\b/i.test((await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").bind(table).first<{sql:string}>())?.sql ?? '');
  const activityReady = async () => {
    const sql = (await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").bind(`${workspace.namespace}_activities`).first<{sql:string}>())?.sql ?? '';
    return { audience: /\bresult_visibility\b/i.test(sql), order: /\bcandidate_order\b/i.test(sql) };
  };
  const photoReplaceReady = async () => Boolean(await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").bind(`${workspace.namespace}_candidate_photo_replace_cleanup`).first());
  const descriptionExists = exists && await descriptionReady(), entriesExist = exists && await entriesReady(), memoExists = exists && await memoReady();
  const activityColumns = exists ? await activityReady() : { audience: false, order: false };
  const audienceExists = activityColumns.audience, orderExists = activityColumns.order;
  const photoReplaceExists = exists && await photoReplaceReady();
  if (descriptionExists && entriesExist && memoExists && audienceExists && photoReplaceExists && orderExists) return;
  const statements = `${exists ? '' : initialSchema}\n${descriptionExists ? '' : candidateDescription}\n${entriesExist ? '' : participantEntries}\n${memoExists ? '' : eventMemo}\n${audienceExists ? '' : resultAudience}\n${photoReplaceExists ? '' : candidatePhotoReplace}\n${orderExists ? '' : candidateOrder}`.split(/;\s*(?:\r?\n|$)/).map(statement => statement.trim()).filter(statement => statement && !/^PRAGMA\b/i.test(statement));
  // D1 batches are atomic; IF NOT EXISTS and seed conflicts also allow concurrent first access.
  try {
    await env.DB.batch([env.DB.prepare('UPDATE member_polls SET initialized=initialized WHERE slug=?').bind(workspace.slug), ...statements.map(statement => env.DB.prepare(workspaceSql(statement
      .replace(/^CREATE (TABLE|INDEX|TRIGGER)\b/i, 'CREATE $1 IF NOT EXISTS')
      .replace(/^INSERT INTO\b/i, 'INSERT OR IGNORE INTO'), workspace.namespace!)))]);
  } catch (error) {
    // Another first request may have completed the same atomic schema upgrade.
    if(await workspaceDeleted(env,workspace))throw error;
    const currentActivity = await activityReady();
    if (!await descriptionReady() || !await entriesReady() || !await memoReady() || !currentActivity.audience || !currentActivity.order || !await photoReplaceReady()) throw error;
  }
}

export function workspacePhotoKey(workspace: Workspace | undefined, key: string) {
  return workspace?.namespace ? `members/${workspace.namespace}/${key}` : key;
}

function workspacePhotos(bucket: R2Bucket, workspace: Workspace, env?:{DB:D1Database}): R2Bucket {
  const prefix = workspace.namespace ? `members/${workspace.namespace}/` : null;
  const check = (key: string) => {
    if (prefix ? !key.startsWith(prefix) : key.startsWith('members/')) throw new Error('Photo outside workspace');
    return key;
  };
  return new Proxy(bucket, {
    get(target, property) {
      if (property === 'get') return (key: string, options?: R2GetOptions) => target.get(check(key), options);
      if (property === 'put') return async (key: string, value: Parameters<R2Bucket['put']>[1], options?: R2PutOptions) => {
        check(key);
        if(env && await workspaceDeleted(env,workspace))throw new Error('poll_deleted');
        const result=await target.put(key,value,options);
        if(env && await workspaceDeleted(env,workspace)){
          await env.DB.prepare('UPDATE member_polls SET cleanup_pending=1,cleanup_version=cleanup_version+1 WHERE slug=? AND deleted_at IS NOT NULL').bind(workspace.slug).run();
          await target.delete(key);
          throw new Error('poll_deleted');
        }
        return result;
      };
      if (property === 'delete') return (key: string | string[]) => target.delete(Array.isArray(key) ? key.map(check) : check(key));
      throw new Error('Unsupported workspace photo operation');
    }
  });
}

export function workspaceEnv<T extends { DB: D1Database; PHOTOS: R2Bucket; ADMIN_SESSION_COOKIE?: string; PARTICIPANT_SESSION_COOKIE?: string; SUPERADMIN_EMAIL?:string }>(env: T, workspace: Workspace): T & { WORKSPACE: Workspace } {
  checkWorkspace(workspace);
  const suffix = workspace.namespace ?? 'owner';
  return { ...env, WORKSPACE: workspace, DB: workspaceDatabase(env.DB, workspace), PHOTOS: workspacePhotos(env.PHOTOS, workspace,env.SUPERADMIN_EMAIL?env:undefined),
    ADMIN_SESSION_COOKIE: workspace.namespace ? `__Host-byob_admin_${suffix}` : env.ADMIN_SESSION_COOKIE,
    PARTICIPANT_SESSION_COOKIE: workspace.namespace ? `__Host-byob_participant_${suffix}` : env.PARTICIPANT_SESSION_COOKIE };
}
