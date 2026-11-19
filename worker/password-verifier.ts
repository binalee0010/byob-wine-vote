import { createHash,randomBytes,scrypt,timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

type Credential={password_hash:string;version:string};
const hashFormat=/^scrypt\$16384\$16\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/;
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
function derive(password:string,salt:string) {
  return new Promise<Buffer>((resolve,reject)=>scrypt(password.normalize('NFKC'),salt,64,{N:16384,r:16,p:1,maxmem:67108864},(error,value)=>error?reject(error):resolve(value)));
}
async function matches(password:string,hash:string) {
  if(!hashFormat.test(hash))return false;
  const [,,,,salt,expected]=hash.split('$');return timingSafeEqual(await derive(password,salt),Buffer.from(expected,'hex'));
}
export class PasswordVerifier {
  constructor(_state:DurableObjectState,private env:{ADMIN_PASSWORD_HASH?:string;DB:D1Database}) {}
  private async credential() {
    const hash=this.env.ADMIN_PASSWORD_HASH;
    if(!hash || !hashFormat.test(hash))return null;
    const fingerprint=createHash('sha256').update(hash).digest('hex'),version=crypto.randomUUID();
    // Remember old Secret fingerprints so an older deployment cannot undo a newer reset.
    await this.env.DB.batch([
      this.env.DB.prepare('INSERT INTO admin_credentials(id,password_hash,bootstrap_fingerprint,version) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash,bootstrap_fingerprint=excluded.bootstrap_fingerprint,version=excluded.version WHERE NOT EXISTS(SELECT 1 FROM admin_bootstrap_history WHERE fingerprint=excluded.bootstrap_fingerprint)').bind(hash,fingerprint,version),
      this.env.DB.prepare('INSERT INTO admin_bootstrap_history(fingerprint) VALUES(?) ON CONFLICT(fingerprint) DO NOTHING').bind(fingerprint)
    ]);
    return this.env.DB.prepare('SELECT password_hash,version FROM admin_credentials WHERE id=1').first<Credential>();
  }
  async fetch(request: Request) {
    const credential=await this.credential();if(!credential)return json({code:'admin_unconfigured'},503);
    const path=new URL(request.url).pathname;
    if(path==='/state' && request.method==='GET')return json({version:credential.version});
    if(request.method!=='POST')return json({code:'not_found'},404);
    const data=await request.json() as Record<string,unknown>;
    if(path==='/verify') {
      if(typeof data.password!=='string' || data.password.length>1024)return json({code:'invalid_request'},400);
      return json({valid:await matches(data.password,credential.password_hash),version:credential.version});
    }
    if(path==='/change') {
      if(typeof data.currentPassword!=='string' || !data.currentPassword.length || data.currentPassword.length>1024 || typeof data.newPassword!=='string' || data.newPassword.length<10 || data.newPassword.length>1024 || typeof data.sessionHash!=='string' || !/^[a-f0-9]{64}$/.test(data.sessionHash))return json({code:'invalid_request'},400);
      if(!await matches(data.currentPassword,credential.password_hash))return json({code:'invalid_current_password'},403);
      const salt=randomBytes(16).toString('hex'),hash=`scrypt$16384$16$1$${salt}$${(await derive(data.newPassword,salt)).toString('hex')}`;
      const changed=await this.env.DB.prepare("UPDATE admin_credentials SET password_hash=?,version=? WHERE id=1 AND version=? AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND role='admin' AND expires_at>? AND credential_version=admin_credentials.version)").bind(hash,crypto.randomUUID(),credential.version,data.sessionHash,Date.now()).run();
      if(!changed.meta.changes)return json({code:'credential_changed'},409);
      return json({ok:true});
    }
    return json({code:'not_found'},404);
  }
}
