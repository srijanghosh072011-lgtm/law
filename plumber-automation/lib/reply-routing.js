'use strict';

/**
 * Which branch an inbound reply takes — spec steps 5, 6, 7.
 *
 * Pulled out of the workflow node so it can be tested. The escalation rules
 * here are the difference between an automation that quietly does the wrong
 * thing and one a plumber can trust.
 */

/**
 * @param {object} opts
 *   @param {string}  opts.intent        YES | NO | STOP | HELP | UNCLEAR
 *   @param {boolean} opts.hasJob        did we find an open appointment?
 *   @param {number}  opts.declineCount  how many times they have already said no
 * @returns {{route: string, why: string}}
 */
function decideRoute({ intent, hasJob, declineCount = 0 }) {
  // 1. Opt-out is honoured with or without a matching job. Someone can STOP
  //    months after their last appointment and it must still work.
  if (intent === 'STOP') return { route: 'STOP', why: 'carrier opt-out keyword' };

  // 2. HELP likewise — a carrier obligation, independent of any booking.
  if (intent === 'HELP') return { route: 'HELP', why: 'carrier help keyword' };

  // 3. Everything else needs a job to act on. A reply we cannot attach to an
  //    appointment goes to a human rather than being silently dropped.
  if (!hasJob) return { route: 'NO_JOB', why: 'no open appointment for this number' };

  if (intent === 'YES') return { route: 'YES', why: 'customer confirmed' };

  if (intent === 'NO') {
    // Spec steps 5 and 6: first no offers a reschedule, second no stops
    // chasing and moves them to long-cycle nurture.
    return declineCount >= 1
      ? { route: 'NO_AGAIN', why: `declined ${declineCount + 1} times — stop chasing` }
      : { route: 'NO_FIRST', why: 'first decline — offer a reschedule' };
  }

  return { route: 'UNCLEAR', why: 'could not determine intent' };
}

module.exports = { decideRoute };
