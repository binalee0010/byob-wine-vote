import { sendBuildFailureNotice } from './signup-mail';
import type { Env } from './index';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function productionBuildFailure(body: unknown) {
  const event = record(body), source = record(event.source), payload = record(event.payload);
  const trigger = record(payload.buildTriggerMetadata), metadata = record(event.metadata);
  if (event.type !== 'cf.workersBuilds.worker.build.failed' || source.type !== 'workersBuilds.worker'
    || source.workerName !== 'vinolog-vote' || (payload.buildOutcome != null && payload.buildOutcome !== 'failure' && payload.buildOutcome !== 'fail')
    || trigger.providerType !== 'github' || trigger.providerAccountName !== 'binalee0010'
    || trigger.repoName !== 'byob-wine-vote' || trigger.branch !== 'main') return null;
  const buildUuid = payload.buildUuid, accountId = metadata.accountId;
  if (typeof buildUuid !== 'string' || !/^(?:build-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(buildUuid)
    || typeof accountId !== 'string' || !/^[a-f0-9]{32}$/i.test(accountId)) return null;
  return { buildUuid: buildUuid.toLowerCase(), accountId: accountId.toLowerCase() };
}

export async function notifyBuildFailures(batch: MessageBatch<unknown>, env: Env) {
  for (const message of batch.messages) {
    const notice = batch.queue === 'vinolog-vote-deploy-failures' ? productionBuildFailure(message.body) : null;
    if (!notice) { message.ack(); continue; }
    try { await sendBuildFailureNotice(env, notice); message.ack(); }
    catch { message.retry(); }
  }
}
