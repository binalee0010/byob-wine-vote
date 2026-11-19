import { randomBytes, scrypt } from 'node:crypto';
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 1024) throw new Error('Use a password of 10–1024 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = await new Promise((resolve, reject) => scrypt(password.normalize('NFKC'), salt, 64, { N:16384,r:16,p:1,maxmem:67108864 }, (error,value) => error ? reject(error) : resolve(value)));
  return `scrypt$16384$16$1$${salt}$${key.toString('hex')}`;
}
