import type { Workspace } from './workspaces';

const alphabet='23456789abcdefghjkmnpqrstuvwxyz';
export const publicAliasPattern=/^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

function randomAlias() {
  let alias='';
  while(alias.length<8)for(const byte of crypto.getRandomValues(new Uint8Array(8))) {
    if(byte<248 && alias.length<8)alias+=alphabet[byte%alphabet.length];
  }
  return alias;
}

export async function ensurePublicPollLink(env:{DB:D1Database},workspace:Pick<Workspace,'slug'>):Promise<string> {
  if(!/^(?:owner|[a-f0-9]{32})$/.test(workspace.slug))throw new Error('Invalid internal poll link');
  const existing=await env.DB.prepare('SELECT alias FROM poll_public_links WHERE poll_slug=?').bind(workspace.slug).first<{alias:string}>();
  if(existing)return existing.alias;
  for(let attempt=0;attempt<16;attempt++) {
    await env.DB.prepare('INSERT INTO poll_public_links(poll_slug,alias) VALUES(?,?) ON CONFLICT DO NOTHING').bind(workspace.slug,randomAlias()).run();
    const link=await env.DB.prepare('SELECT alias FROM poll_public_links WHERE poll_slug=?').bind(workspace.slug).first<{alias:string}>();
    if(link)return link.alias;
  }
  throw new Error('Unable to allocate public poll link');
}
