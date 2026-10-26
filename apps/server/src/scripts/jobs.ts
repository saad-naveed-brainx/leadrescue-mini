/**
 * Looks after jobs that failed for good ("dead"):
 *
 *   npm run jobs -- list-dead          show them, with why they failed
 *   npm run jobs -- retry <job id>     give one a fresh start (recorded in the audit history)
 */
import { userInfo } from 'node:os';
import { z } from 'zod';
import { db } from '../db.js';
import { listDeadJobs, retryDeadJob } from '../services/jobs.js';

const [command, jobId] = process.argv.slice(2);

try {
  if (command === 'list-dead') {
    const jobs = await listDeadJobs();
    if (jobs.length === 0) console.log('No dead jobs.');
    for (const j of jobs) {
      console.log(
        `${j.id}  ${j.type.padEnd(9)}  ${j.attempts} attempts  ${j.finishedAt.toISOString()}  ${j.lastError ?? ''}`,
      );
    }
  } else if (command === 'retry' && z.uuid().safeParse(jobId).success) {
    const ok = await retryDeadJob(jobId!, userInfo().username);
    console.log(ok ? `Job ${jobId} is waiting again.` : `No dead job with id ${jobId}.`);
    process.exitCode = ok ? 0 : 1;
  } else {
    console.log('Usage: npm run jobs -- list-dead | retry <job id>');
    process.exitCode = 1;
  }
} finally {
  await db.end();
}
