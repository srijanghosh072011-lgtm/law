'use strict';

/**
 * Every customer-facing message in the system.
 *
 * Kept in one file on purpose: when you sell this to the next plumber, this is
 * the file you rebrand. No copy is buried inside a workflow node.
 *
 * SMS RULES BAKED IN HERE:
 *  - The business name appears in every SMS. Carriers require the sender to be
 *    identifiable; unbranded messages are a common A2P rejection reason.
 *  - The first message to a customer carries "Reply STOP to opt out".
 *  - Nothing is longer than needed. A message over 160 GSM characters bills as
 *    multiple segments, so length is money.
 */

const { business } = require('./config.js');

/** Format a timestamp for a human, in the business's timezone. */
function when(date, timezone, opts = {}) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
    ...opts,
  }).format(new Date(date));
}

function dayOnly(date, timezone) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  }).format(new Date(date));
}

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

/** Wraps body copy in a plain, deliverable HTML shell. */
function emailShell(bizName, bodyHtml) {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1e21;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;padding:28px 32px;">
    <h1 style="margin:0 0 20px;font-size:17px;letter-spacing:.02em;text-transform:uppercase;color:#5b6472;">${bizName}</h1>
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #e6e8eb;margin:28px 0 16px;">
    <p style="margin:0;font-size:12px;color:#8a929c;">${bizName}</p>
  </div>
</body></html>`;
}

function templates(env = process.env) {
  const biz = business(env);
  const tz = biz.timezone;

  return {
    // --- Step 1: booking confirmation ------------------------------------
    bookingConfirmationSms: ({ customer, job }) =>
      `${biz.name}: Hi ${customer.full_name.split(' ')[0]}, your ${job.job_type.replace(/_/g, ' ')} appointment is booked for ${when(job.scheduled_start, tz)}. We'll text you the day before to confirm. Questions? Call ${biz.phone}. Reply STOP to opt out.`,

    bookingConfirmationEmail: ({ customer, job }) => ({
      subject: `Your appointment is booked — ${dayOnly(job.scheduled_start, tz)}`,
      html: emailShell(
        biz.name,
        `<p style="font-size:15px;line-height:1.55;">Hi ${customer.full_name.split(' ')[0]},</p>
         <p style="font-size:15px;line-height:1.55;">Thanks for booking with us. Here are your details:</p>
         <table style="width:100%;border-collapse:collapse;font-size:15px;margin:20px 0;">
           <tr><td style="padding:8px 0;color:#6b7280;width:120px;">Service</td><td style="padding:8px 0;font-weight:600;">${job.job_type.replace(/_/g, ' ')}</td></tr>
           <tr><td style="padding:8px 0;color:#6b7280;">When</td><td style="padding:8px 0;font-weight:600;">${when(job.scheduled_start, tz)}</td></tr>
           <tr><td style="padding:8px 0;color:#6b7280;">Where</td><td style="padding:8px 0;font-weight:600;">${customer.address_line}${customer.city ? ', ' + customer.city : ''}</td></tr>
         </table>
         <p style="font-size:15px;line-height:1.55;">We'll send a text the day before to confirm, and another when your technician is on the way.</p>
         <p style="font-size:15px;line-height:1.55;">Need to change anything? Call us on ${biz.phone}.</p>`
      ),
    }),

    // --- Step 3: the partner's dispatch notice ---------------------------
    partnerDispatchSms: ({ partner, customer, job }) =>
      `New job assigned: ${job.job_type.replace(/_/g, ' ')} — ${when(job.scheduled_start, tz)} at ${customer.address_line}, ${customer.city || ''}. ${customer.full_name}, ${customer.phone}.${job.urgency === 'emergency' ? ' *** EMERGENCY ***' : ''}`,

    // --- Step 4: the T-24 yes/no confirmation ----------------------------
    // The literal words YES and NO matter — sms-parser.js keys off them, and
    // customers copy the format back at you.
    t24ConfirmSms: ({ customer, job }) =>
      `${biz.name}: Hi ${customer.full_name.split(' ')[0]}, we have you booked for ${when(job.scheduled_start, tz)} tomorrow. Reply YES to confirm or NO if you need to reschedule.`,

    /** One nudge for people who simply didn't reply. */
    t24NudgeSms: ({ job }) =>
      `${biz.name}: Just checking in on tomorrow's ${when(job.scheduled_start, tz)} appointment. Reply YES to confirm or NO to reschedule. If we don't hear back we'll hold your slot.`,

    // --- Step 4 (yes): confirmed -----------------------------------------
    confirmedSms: ({ job }) =>
      `${biz.name}: You're all set for ${when(job.scheduled_start, tz)}. We'll text when your technician is on the way. See you then.`,

    // --- Step 5: reschedule (first "no") ---------------------------------
    rescheduleSms: () =>
      `${biz.name}: No problem — we've released that slot. Pick a new time that suits you here: ${biz.bookingUrl}`,

    rescheduleEmail: ({ customer }) => ({
      subject: 'Pick a new time for your appointment',
      html: emailShell(
        biz.name,
        `<p style="font-size:15px;line-height:1.55;">Hi ${customer.full_name.split(' ')[0]},</p>
         <p style="font-size:15px;line-height:1.55;">No problem at all — we've released your slot. Whenever you're ready, pick a time that works better:</p>
         <p style="margin:24px 0;"><a href="${biz.bookingUrl}" style="background:#1a56db;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">Choose a new time</a></p>
         <p style="font-size:15px;line-height:1.55;">Or just call us on ${biz.phone}.</p>`
      ),
    }),

    // --- Step 6: nurture (second "no") -----------------------------------
    nurtureSms: () =>
      `${biz.name}: We'll stop chasing this one. We're here whenever you need us — ${biz.phone}. Reply STOP to opt out.`,

    // --- Step 9: on the way ----------------------------------------------
    onMyWaySms: ({ customer, partnerName, etaMinutes }) =>
      `${biz.name}: ${partnerName} is on the way to ${customer.address_line} and should arrive in about ${etaMinutes} minutes.`,

    // --- Step 10: the job report -----------------------------------------
    reportEmail: ({ customer, job, reportMarkdown }) => ({
      subject: `Your service report — ${dayOnly(job.scheduled_start, tz)}`,
      html: emailShell(
        biz.name,
        `<p style="font-size:15px;line-height:1.55;">Hi ${customer.full_name.split(' ')[0]},</p>
         <p style="font-size:15px;line-height:1.55;">Here's a summary of the work we completed today.</p>
         <div style="font-size:15px;line-height:1.6;border-left:3px solid #e6e8eb;padding-left:18px;margin:22px 0;">
           ${markdownToBasicHtml(reportMarkdown)}
         </div>
         <p style="font-size:15px;line-height:1.55;">Your invoice will arrive separately. Any questions, just reply to this email.</p>`
      ),
    }),

    // --- Step 12: feedback request ---------------------------------------
    feedbackEmail: ({ customer, job, feedbackUrl }) => ({
      subject: 'How did we do?',
      html: emailShell(
        biz.name,
        `<p style="font-size:15px;line-height:1.55;">Hi ${customer.full_name.split(' ')[0]},</p>
         <p style="font-size:15px;line-height:1.55;">Thanks for having us out. How did we do?</p>
         <p style="margin:24px 0;">
           ${[1, 2, 3, 4, 5]
             .map(
               (n) =>
                 `<a href="${feedbackUrl}?job=${job.id}&rating=${n}" style="display:inline-block;padding:11px 17px;margin-right:6px;border:1px solid #d7dae0;border-radius:6px;text-decoration:none;color:#1c1e21;font-size:16px;font-weight:600;">${n}</a>`
             )
             .join('')}
         </p>
         <p style="font-size:13px;color:#6b7280;">1 = poor, 5 = excellent. Takes one click.</p>`
      ),
    }),

    // --- Step 14: positive path ------------------------------------------
    thankYouEmail: ({ customer, discountCode, discountPercent }) => ({
      subject: `Thank you, ${customer.full_name.split(' ')[0]} — here's ${discountPercent}% off your next visit`,
      html: emailShell(
        biz.name,
        `<p style="font-size:15px;line-height:1.55;">Hi ${customer.full_name.split(' ')[0]},</p>
         <p style="font-size:15px;line-height:1.55;">Thank you — that means a lot to a small team like ours.</p>
         <p style="font-size:15px;line-height:1.55;">Here's <strong>${discountPercent}% off</strong> your next service. Just mention this code:</p>
         <p style="margin:18px 0;"><span style="display:inline-block;border:2px dashed #1a56db;color:#1a56db;padding:12px 22px;border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:19px;font-weight:700;letter-spacing:.08em;">${discountCode}</span></p>
         <p style="font-size:15px;line-height:1.55;">If you have 30 seconds, a Google review genuinely helps people find us:</p>
         <p style="margin:22px 0;"><a href="${biz.reviewUrl}" style="background:#1a56db;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">Leave a review</a></p>`
      ),
    }),

    // --- Step 13: negative path ------------------------------------------
    // Goes to the customer. Deliberately does NOT ask for a review, and does
    // not offer a discount — it opens a conversation instead.
    serviceRecoveryEmail: ({ customer }) => ({
      subject: 'We got your feedback — and we want to put it right',
      html: emailShell(
        biz.name,
        `<p style="font-size:15px;line-height:1.55;">Hi ${customer.full_name.split(' ')[0]},</p>
         <p style="font-size:15px;line-height:1.55;">Thanks for being straight with us — that wasn't the standard we aim for.</p>
         <p style="font-size:15px;line-height:1.55;">The owner has your details and will call you personally within one business day. If you'd rather reach us first, we're on ${biz.phone}.</p>`
      ),
    }),

    // --- Step 15: nurture / preventative maintenance ---------------------
    maintenanceEmail: ({ customer, monthsSince }) => ({
      subject: `Time for a check-up? It's been ${monthsSince} months`,
      html: emailShell(
        biz.name,
        `<p style="font-size:15px;line-height:1.55;">Hi ${customer.full_name.split(' ')[0]},</p>
         <p style="font-size:15px;line-height:1.55;">It's been about ${monthsSince} months since we were out. Most of the emergency calls we take started as something small and cheap that nobody caught in time.</p>
         <p style="font-size:15px;line-height:1.55;">A preventative check covers water heater condition, visible pipework, shut-off valves and drain flow.</p>
         <p style="margin:24px 0;"><a href="${biz.bookingUrl}" style="background:#1a56db;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">Book a check-up</a></p>`
      ),
    }),

    // --- Internal: owner callback task (step 13) -------------------------
    ownerTaskTitle: ({ customer, rating }) =>
      `Call ${customer.full_name} — ${rating}/5 feedback`,

    ownerTaskDetail: ({ customer, job, feedbackText }) =>
      [
        `Customer: ${customer.full_name} (${customer.phone})`,
        `Job: ${job.job_type.replace(/_/g, ' ')} on ${when(job.scheduled_start, tz)}`,
        `Address: ${customer.address_line}`,
        '',
        `What they said: ${feedbackText || '(no comment left)'}`,
        '',
        'Call within one business day. Do not send a review request to this customer.',
      ].join('\n'),

    helpers: { when, dayOnly, money },
  };
}

/** Minimal markdown -> HTML. Only what Claude's report actually emits. */
function markdownToBasicHtml(md) {
  return String(md || '')
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('## ')) {
        return `<h3 style="font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:#5b6472;margin:20px 0 8px;">${trimmed.slice(3)}</h3>`;
      }
      if (/^[-*] /m.test(trimmed)) {
        const items = trimmed
          .split('\n')
          .filter((l) => /^[-*] /.test(l.trim()))
          .map((l) => `<li style="margin-bottom:5px;">${l.trim().slice(2)}</li>`)
          .join('');
        return `<ul style="margin:8px 0;padding-left:20px;">${items}</ul>`;
      }
      if (/^\*.*\*$/.test(trimmed)) {
        return `<p style="font-size:13px;color:#8a929c;font-style:italic;margin:14px 0 0;">${trimmed.replace(/^\*|\*$/g, '')}</p>`;
      }
      return `<p style="margin:0 0 12px;">${trimmed.replace(/\n/g, ' ')}</p>`;
    })
    .join('\n');
}

module.exports = { templates, markdownToBasicHtml, when, dayOnly };
