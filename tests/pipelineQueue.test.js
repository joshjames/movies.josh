const test = require('node:test');
const assert = require('node:assert/strict');
const { createJob, updateJob, getNextRunnableJob, getJobSnapshot } = require('../src/services/PipelineQueueService');

test('createJob and transition through steps', () => {
  const job = createJob({
    imdbId: 'tt1190634',
    contentType: 'movie',
    payload: {
      torrentName: 'The Batman',
      rawPath: '/downloads/The Batman'
    }
  });

  assert.equal(job.status, 'QUEUED');
  assert.equal(job.currentStep, 'INGEST');
  assert.equal(job.payload.torrentName, 'The Batman');

  const updated = updateJob(job, {
    status: 'PROCESSING',
    currentStep: 'METADATA',
    history: [{ step: 'INGEST', timestamp: '2026-06-30T13:30:00Z' }]
  });

  assert.equal(updated.status, 'PROCESSING');
  assert.equal(updated.currentStep, 'METADATA');
  assert.equal(updated.history.length, 1);

  const snapshot = getJobSnapshot(updated);
  assert.equal(snapshot.currentStep, 'METADATA');
});

test('getNextRunnableJob returns the earliest pending job', () => {
  const jobs = [
    createJob({ id: 'job-1', payload: { torrentName: 'A' } }),
    createJob({ id: 'job-2', payload: { torrentName: 'B' } })
  ];

  const first = getNextRunnableJob(jobs);
  assert.equal(first.id, 'job-1');
});
