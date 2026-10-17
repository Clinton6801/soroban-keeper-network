/**
 * Oracle condition evaluation module for keeper-bot-v2
 *
 * Implements off-chain oracle feed reading and condition prediction (issue #0426).
 *
 * Key responsibilities:
 * 1. Cache oracle feeds per-round (read once, not per-task)
 * 2. Predict oracle condition outcomes before simulation
 * 3. Track prediction accuracy and log mismatches
 * 4. Support graceful fallback to on-chain simulation
 *
 * Oracle conditions are structured as:
 * - Asset identifiers (e.g., "BTC/USD")
 * - Operator (>=, >, <=, <)
 * - Threshold value
 * - Direction (above/below)
 *
 * This module reads feeds off-chain to predict claimability without per-task simulation,
 * saving significant RPC bandwidth when multiple tasks share the same feed.
 */

/**
 * Represents an oracle feed identifier
 * (e.g., "BTC/USD", "ETH/USD")
 */
export interface OracleFeedId {
  base: string;
  quote: string;
}

/**
 * Current price and metadata from an oracle feed
 */
export interface OracleFeedData {
  feedId: OracleFeedId;
  price: bigint;
  decimals: number;
  timestamp: number; // Unix seconds
  source: string;
}

/**
 * Oracle price-threshold condition decoded from task calldata
 */
export interface OraclePriceThresholdCondition {
  feedId: OracleFeedId;
  threshold: bigint;
  direction: "above" | "below"; // Direction the price must cross
  decimals: number; // Normalized decimals for threshold comparison
}

/**
 * Prediction result for whether a task's condition is claimable
 */
export interface ConditionPrediction {
  claimable: boolean; // true if condition is met
  prediction_method: "oracle_feed" | "simulated" | "unknown";
  timestamp: number; // When the prediction was made (Unix seconds)
  details?: {
    feed_price?: bigint;
    threshold?: bigint;
    direction?: string;
    reason?: string;
  };
}

/**
 * Mismatch between predicted and actual on-chain condition result
 */
export interface ConditionMismatch {
  taskId: bigint;
  feedId?: OracleFeedId;
  predicted: boolean;
  actual: boolean;
  timestamp: number;
  description: string;
}

/**
 * Result of validating a prediction against actual on-chain outcome
 */
export interface PredictionValidationResult {
  taskId: bigint;
  predicted: boolean;
  actual: boolean;
  matches: boolean; // true if prediction was correct
  mismatchReason?: string;
}

/**
 * Cache for oracle feeds within a single round.
 * Implements: "The bot reads each distinct feed once per round, not once per task"
 */
export class OracleFeedCache {
  private feeds: Map<string, OracleFeedData> = new Map();
  private mismatches: ConditionMismatch[] = [];
  private readCount = 0;

  /**
   * Get or read an oracle feed, using cache if available.
   * Multiple tasks referring to the same feed get the same cached value.
   *
   * @param feedId Feed identifier to read
   * @param reader Function to fetch feed data from the oracle
   * @returns Feed data from cache or fresh read
   */
  async getFeed(
    feedId: OracleFeedId,
    reader: (feedId: OracleFeedId) => Promise<OracleFeedData>
  ): Promise<OracleFeedData> {
    const key = `${feedId.base}/${feedId.quote}`;
    const cached = this.feeds.get(key);

    if (cached) {
      return cached;
    }

    // Feed not cached — read it once
    const feed = await reader(feedId);
    this.feeds.set(key, feed);
    this.readCount += 1;

    return feed;
  }

  /**
   * Record a mismatch between predicted and actual condition result.
   * Used for post-execution validation and logging.
   */
  recordMismatch(mismatch: ConditionMismatch): void {
    this.mismatches.push(mismatch);
  }

  /**
   * Get all mismatches recorded in this round.
   */
  getMismatches(): ConditionMismatch[] {
    return [...this.mismatches];
  }

  /**
   * Get statistics about feed reads in this round.
   */
  getStats(): {
    distinctFeeds: number;
    totalReads: number;
    mismatches: number;
  } {
    return {
      distinctFeeds: this.feeds.size,
      totalReads: this.readCount,
      mismatches: this.mismatches.length,
    };
  }

  /**
   * Clear the cache between rounds.
   */
  reset(): void {
    this.feeds.clear();
    this.mismatches = [];
    this.readCount = 0;
  }
}

/**
 * Evaluate whether an oracle price-threshold condition is claimable.
 *
 * Compares the current oracle feed price against the threshold according to direction:
 * - direction="above": claimable if price >= threshold
 * - direction="below": claimable if price <= threshold
 *
 * @param condition The oracle price-threshold condition
 * @param feedData The current oracle feed data
 * @returns Whether the condition is claimable based on the feed price
 */
export function evaluateOracleCondition(
  condition: OraclePriceThresholdCondition,
  feedData: OracleFeedData
): boolean {
  const { threshold, direction } = condition;
  const price = feedData.price;

  // Normalize prices to the same decimal scale for comparison
  // (both should already be normalized by the reader, but enforce here)
  const priceNormalized = price;
  const thresholdNormalized = threshold;

  if (direction === "above") {
    // Claimable if price >= threshold (crossed above or at threshold)
    return priceNormalized >= thresholdNormalized;
  } else {
    // Claimable if price <= threshold (crossed below or at threshold)
    return priceNormalized <= thresholdNormalized;
  }
}

/**
 * Predict whether a task with an oracle condition is claimable, based on feed data.
 *
 * This avoids a per-task simulation by reading the oracle feed once per round
 * and checking the condition logic directly.
 *
 * @param condition The oracle condition to evaluate
 * @param feedData The oracle feed data
 * @param feedCache The feed cache (for tracking read counts)
 * @returns Prediction result with method and details
 */
export function predictOracleCondition(
  condition: OraclePriceThresholdCondition,
  feedData: OracleFeedData,
  feedCache?: OracleFeedCache
): ConditionPrediction {
  const claimable = evaluateOracleCondition(condition, feedData);

  return {
    claimable,
    prediction_method: "oracle_feed",
    timestamp: Math.floor(Date.now() / 1000),
    details: {
      feed_price: feedData.price,
      threshold: condition.threshold,
      direction: condition.direction,
      reason: claimable
        ? `Price ${feedData.price} ${condition.direction === "above" ? ">=" : "<="} threshold ${condition.threshold}`
        : `Price ${feedData.price} ${condition.direction === "above" ? "<" : ">"} threshold ${condition.threshold}`,
    },
  };
}

/**
 * Decode an oracle price-threshold condition from task calldata.
 *
 * The calldata encoding follows the keeper-registry contract's expectation:
 * Callers should implement this based on their SDK helpers (issue #0424).
 *
 * For now, this is a placeholder that returns undefined; actual decoding
 * will be implemented once the SDK helpers (issue #0424) are available.
 *
 * Test implementations use helpers/oracle-encoding.ts for validation.
 *
 * @param calldata Task calldata bytes
 * @returns Decoded oracle condition, or undefined if not an oracle condition
 */
export function decodeOraclePriceThresholdCondition(
  _calldata: Buffer
): OraclePriceThresholdCondition | undefined {
  // TODO: Implement decoding once SDK helpers (issue #0424) are available.
  // Expected structure from the contract:
  // - Feed identifier (base/quote assets)
  // - Threshold value (ScVal int128)
  // - Direction (enum: above/below)
  // - Optional: decimals normalization info
  //
  // For now, return undefined to signal "not decoded yet"
  // Tests can use the test helper in test/helpers/oracle-encoding.ts
  return undefined;
}

/**
 * Attempt to decode an oracle condition from task calldata.
 *
 * Supports multiple condition types (currently price-threshold).
 * Returns undefined if the condition cannot be decoded or is not an oracle condition.
 *
 * @param calldata Task calldata bytes
 * @returns Oracle condition, or undefined if not an oracle condition or decodable
 */
export function decodeOracleCondition(
  calldata: Buffer
): OraclePriceThresholdCondition | undefined {
  // Try to decode as oracle price-threshold condition
  const priceThreshold = decodeOraclePriceThresholdCondition(calldata);
  if (priceThreshold) {
    return priceThreshold;
  }

  // Future: add other oracle condition types here
  // - deviation conditions
  // - multi-feed conditions
  // etc.

  return undefined;
}

/**
 * Validate that a prediction result is well-formed and consistent.
 *
 * Used for internal testing and fallback logic.
 *
 * @param prediction The prediction to validate
 * @returns Error message if invalid, undefined if valid
 */
export function validatePrediction(prediction: ConditionPrediction): string | undefined {
  if (prediction.prediction_method === undefined) {
    return "prediction_method is required";
  }

  if (prediction.timestamp === undefined || prediction.timestamp <= 0) {
    return `invalid timestamp: ${prediction.timestamp}`;
  }

  if (typeof prediction.claimable !== "boolean") {
    return `claimable must be boolean, got ${typeof prediction.claimable}`;
  }

  if (
    prediction.prediction_method === "oracle_feed" &&
    (!prediction.details || prediction.details.feed_price === undefined)
  ) {
    return "oracle_feed predictions must include details.feed_price";
  }

  return undefined;
}

/**
 * Validate a prediction against actual on-chain condition result.
 *
 * @param taskId Task ID
 * @param predicted Predicted outcome from oracle feed
 * @param actual Actual outcome from on-chain evaluation
 * @returns Validation result with match status and mismatch reason if applicable
 */
export function validatePredictionAgainstActual(
  taskId: bigint,
  predicted: boolean,
  actual: boolean
): PredictionValidationResult {
  const matches = predicted === actual;

  return {
    taskId,
    predicted,
    actual,
    matches,
    mismatchReason: matches
      ? undefined
      : `Predicted ${predicted} but on-chain result was ${actual}`,
  };
}
