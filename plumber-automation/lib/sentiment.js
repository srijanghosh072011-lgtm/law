'use strict';

/**
 * Feedback classification and routing — spec steps 12, 13, 14.
 *
 * Decides what happens after a customer answers "how did we do?":
 *   negative -> a task for the owner to call them                (step 13)
 *   neutral  -> a quiet follow-up, and NO review request
 *   positive -> thank-you, discount, Google review link          (step 14)
 *
 * TWO RULES THAT ARE EASY TO GET WRONG:
 *
 * 1. NEVER ask for a public review below 4 stars. Asking a 2-star customer to
 *    review you on Google is asking them to publish the complaint. It is the
 *    single most damaging thing a badly built feedback automation does, and it
 *    is why "send the review link to everyone" is wrong.
 *
 * 2. A 3-star review is not a win. It drags the average down and reads as
 *    lukewarm. Neutral customers get a human follow-up, not a review link.
 *
 * The star rating is the primary signal because it is unambiguous and free.
 * Claude is only consulted for free text with no rating attached.
 */

/** Ratings at or below this get the service-recovery path. */
const NEGATIVE_MAX = 2;
/** Ratings at or above this may be asked for a public review. */
const REVIEW_MIN = 4;

/** Obvious signals, checked before spending a Claude call. */
const NEGATIVE_MARKERS = [
  'terrible', 'awful', 'horrible', 'worst', 'rude', 'unprofessional',
  'late', 'never showed', 'no show', 'overcharged', 'rip off', 'ripoff',
  'scam', 'disappointed', 'disappointing', 'unhappy', 'angry', 'furious',
  'still leaking', 'still broken', 'made it worse', 'damaged', 'mess',
  'refund', 'complaint', 'waste of money', 'not fixed', 'came back',
];

const POSITIVE_MARKERS = [
  'excellent', 'fantastic', 'wonderful', 'amazing', 'perfect', 'brilliant',
  'professional', 'courteous', 'polite', 'on time', 'punctual', 'tidy',
  'clean', 'thorough', 'quick', 'fast', 'friendly', 'helpful', 'lifesaver',
  'highly recommend', 'would recommend', 'great job', 'well done',
  'very happy', 'delighted', 'impressed', 'thank you', 'thanks',
];

/**
 * Classify from a star rating alone. Deterministic and free — always
 * preferred over asking a model.
 */
function fromRating(rating) {
  const n = Number(rating);
  if (!Number.isFinite(n)) return null;

  if (n <= NEGATIVE_MAX) {
    return { sentiment: 'negative', confidence: 'high', source: 'rating', rating: n };
  }
  if (n >= REVIEW_MIN) {
    return { sentiment: 'positive', confidence: 'high', source: 'rating', rating: n };
  }
  return { sentiment: 'neutral', confidence: 'high', source: 'rating', rating: n };
}

/**
 * Classify free text by keyword. Returns null when the text is genuinely
 * unclear, so the caller can escalate to Claude rather than guessing.
 */
function fromKeywords(text) {
  if (!text || !String(text).trim()) return null;

  const lower = String(text).toLowerCase();
  const negatives = NEGATIVE_MARKERS.filter((m) => lower.includes(m));
  const positives = POSITIVE_MARKERS.filter((m) => lower.includes(m));

  // Mixed feedback is real and common ("great work but he was two hours
  // late"). Treat it as negative: the complaint is the part that needs a
  // human, and a public review request would be tone-deaf.
  if (negatives.length && positives.length) {
    return {
      sentiment: 'negative', confidence: 'medium', source: 'keywords',
      matched: { negatives, positives },
      note: 'mixed feedback — the complaint takes priority',
    };
  }
  if (negatives.length) {
    return { sentiment: 'negative', confidence: 'medium', source: 'keywords', matched: { negatives } };
  }
  if (positives.length) {
    return { sentiment: 'positive', confidence: 'medium', source: 'keywords', matched: { positives } };
  }
  return null;
}

/**
 * The decision the workflow acts on.
 *
 * @param {object} feedback  { rating?, text? }
 * @returns {{sentiment, confidence, source, actions, needsModel}}
 *   `needsModel: true` means neither the rating nor keywords settled it and
 *   the caller should ask Claude, then re-run with the answer.
 */
function classifyFeedback({ rating, text } = {}) {
  const byRating = fromRating(rating);
  const byKeywords = fromKeywords(text);

  // A rating plus contradicting text ("5 stars" alongside "still leaking")
  // is worth a human either way — take the more cautious reading.
  if (byRating && byKeywords && byRating.sentiment !== byKeywords.sentiment) {
    const cautious = [byRating, byKeywords].find((r) => r.sentiment === 'negative')
      || { sentiment: 'neutral' };
    return decide({
      sentiment: cautious.sentiment,
      confidence: 'low',
      source: 'rating+text conflict',
      rating: byRating.rating,
      note: `rating said ${byRating.sentiment}, the comment said ${byKeywords.sentiment}`,
    });
  }

  const chosen = byRating || byKeywords;

  if (!chosen) {
    return {
      sentiment: 'unknown',
      confidence: 'none',
      source: 'none',
      needsModel: Boolean(text && String(text).trim()),
      actions: { reviewRequest: false, discount: false, ownerCallback: false, nurture: true },
    };
  }

  return decide(chosen);
}

/** Turn a sentiment into the concrete actions the workflow performs. */
function decide(result) {
  const { sentiment, rating } = result;

  // Rule 1 in the header: a review link only goes out at 4+ stars, and only
  // when we are actually confident.
  const canAskForReview =
    sentiment === 'positive' &&
    result.confidence !== 'low' &&
    (rating === undefined || rating >= REVIEW_MIN);

  return {
    ...result,
    needsModel: false,
    actions: {
      // Step 14
      reviewRequest: canAskForReview,
      discount: sentiment === 'positive',
      thankYou: sentiment === 'positive',
      // Step 13
      ownerCallback: sentiment === 'negative',
      recoveryEmail: sentiment === 'negative',
      // A 3-star is a quiet follow-up: no review ask, no urgent call.
      quietFollowUp: sentiment === 'neutral',
      // Step 15 — everyone, whatever they said.
      nurture: true,
    },
  };
}

/**
 * Prompt for the Claude call, used only when classifyFeedback returns
 * needsModel. Constrained to one word so the response is trivial to parse.
 */
function modelPrompt(text) {
  return [
    'Classify this feedback about a plumbing job as exactly one word:',
    'positive, negative, or neutral.',
    '',
    'Treat any unresolved complaint, damage, lateness or billing dispute as',
    'negative, even if the customer is polite about it.',
    '',
    'Feedback: "' + String(text).replace(/"/g, "'") + '"',
    '',
    'Answer with one word only.',
  ].join('\n');
}

/** Parse the model's reply defensively — anything unexpected becomes neutral. */
function parseModelSentiment(reply) {
  const word = String(reply || '').toLowerCase().trim().replace(/[^a-z]/g, '');
  if (word.startsWith('positive')) return 'positive';
  if (word.startsWith('negative')) return 'negative';
  // Neutral is the safe landing: no review request, no urgent callback.
  return 'neutral';
}

/** A per-customer discount code that is stable and readable over the phone. */
function discountCode(customerName, jobId) {
  const initials = String(customerName || 'XX')
    .split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().slice(0, 2);
  const suffix = String(jobId || '').replace(/-/g, '').slice(-4).toUpperCase();
  return `THANKS${initials}${suffix}`;
}

module.exports = {
  classifyFeedback, fromRating, fromKeywords, decide,
  modelPrompt, parseModelSentiment, discountCode,
  NEGATIVE_MAX, REVIEW_MIN, NEGATIVE_MARKERS, POSITIVE_MARKERS,
};
