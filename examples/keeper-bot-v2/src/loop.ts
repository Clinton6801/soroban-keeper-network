/**
 * Round processing loop for keeper-bot-v2 (issue #0253, #0261, #0426)
 *
 * This module orchestrates the keeper round workflow:
 * 1. Discover candidate tasks from events
 * 2. Evaluate each candidate for profitability and eligibility
 * 3. Pre-check oracle conditions off-chain (issue #0426) to skip unprofitable simulations
 * 4. Rank candidates by expected net profit (descending)
 * 5. Process ranked candidates until round budget exhausted
 * 6. Record outcomes and track oracle prediction accuracy
 *
 * Oracle condition prechecking (issue #0426):
 * - Reads each distinct oracle feed once per round (not per-task)
 * - Predicts oracle condition outcomes before on-chain simulation
 * - Tracks prediction accuracy and logs mismatches for monitoring
 * - Falls back to simulation if feed read fails
 *
 * Future phases will extend this with:
 * - Concurrent task processing within a round
 * - Persistent state to prevent double-claiming across restarts
 * - Fee market adaptation and resource budget enforcement
 */

import type {
  CandidateTask,
  EvaluatedCandidate,
  RoundSummary,
  KeeperBotConfig,
  RankedCandidate,
  ConditionEvaluationOptions,
} from "./types.js";
import { rankCandidatesByProfit, selectTopCandidates } from "./ranking.js";
import type { ProfitabilityConfig } from "./profitability.js";
import {
  OracleFeedCache,
  decodeOracleCondition,
  predictOracleCondition,
  type OracleFeedData,
} from "./conditions.js";

/**
 * Placeholder for the round processing loop.
 *
 * The actual implementation will:
 * 1. Call a task source (events, indexer, etc.) to discover candidates
 * 2. Fetch full details for each candidate from the contract
 * 3. Evaluate profitability using the profitability module
 * 4. Rank by expected net profit
 * 5. Process in rank order, respecting round limits
 *
 * @param _candidates - Discovered candidate tasks
 * @param _config - Keeper bot configuration
 * @returns Summary of the completed round
 */
export async function processRound(
  _candidates: CandidateTask[],
  _config: KeeperBotConfig
): Promise<RoundSummary> {
  // Placeholder implementation for now
  // The actual loop will be implemented as part of the full v2 package
  return {
    processed: 0,
    selected: [],
    skipped: {
      unprofitable: [],
      noExecutor: [],
      pastDeadline: [],
      condition_not_met: [],
      oracle_prediction_unmet: [],
      other: [],
    },
    errors: [],
    totalNetProfit: 0n,
    durationMs: 0,
  };
}

/**
 * Core workflow: evaluate and rank candidates for processing.
 *
 * This function encapsulates the candidate evaluation and ranking logic
 * that is independent of how candidates were discovered or how the round
 * results are executed.
 *
 * @param candidates - Array of evaluated candidates
 * @param profitabilityConfig - Configuration for profitability calculation
 * @param maxTasksPerRound - Maximum tasks to process in this round
 * @returns Ranked candidates selected for processing
 */
export function evaluateAndRankCandidates(
  candidates: EvaluatedCandidate[],
  profitabilityConfig: ProfitabilityConfig,
  maxTasksPerRound: number
): RankedCandidate[] {
  // Rank all candidates by expected net profit (descending)
  const ranked = rankCandidatesByProfit(candidates, profitabilityConfig);

  // Select top N candidates to process in this round
  const selected = selectTopCandidates(ranked, maxTasksPerRound);

  return selected;
}

/**
 * Pre-check oracle conditions for a set of candidates using off-chain feed data.
 *
 * Implements issue #0426: reads each distinct oracle feed once per round,
 * predicts oracle condition outcomes, and filters candidates whose conditions
 * are predicted unmet.
 *
 * Results are attached to candidates' condition.prediction fields for later
 * logging and mismatch detection.
 *
 * @param candidates - Array of evaluated candidates
 * @param feedReader - Function to fetch oracle feed data by feed ID
 * @param options - Configuration for oracle precheck behavior
 * @returns Object with:
 *   - candidates: Input candidates with condition predictions attached
 *   - cache: Feed cache for round statistics and mismatch tracking
 *   - skippedByOraclePrediction: Task IDs skipped due to unmet oracle predictions
 */
export async function preCheckOracleConditions(
  candidates: EvaluatedCandidate[],
  feedReader: (feedId: any) => Promise<OracleFeedData>,
  options: ConditionEvaluationOptions = {}
): Promise<{
  candidates: EvaluatedCandidate[];
  cache: OracleFeedCache;
  skippedByOraclePrediction: bigint[];
}> {
  const {
    useOraclePrediction = true,
    fallbackToSimulation = true,
  } = options;

  const cache = new OracleFeedCache();
  const skippedByOraclePrediction: bigint[] = [];

  if (!useOraclePrediction) {
    // Oracle prechecking disabled; return candidates unchanged
    return {
      candidates,
      cache,
      skippedByOraclePrediction,
    };
  }

  // Process each candidate for oracle conditions
  for (const candidate of candidates) {
    try {
      // Try to decode an oracle condition from the task's calldata
      const oracleCondition = decodeOracleCondition(candidate.calldata);
      if (!oracleCondition) {
        // Not an oracle condition; skip precheck
        continue;
      }

      try {
        // Read or retrieve cached feed data for this condition
        const feedData = await cache.getFeed(oracleCondition.feedId, feedReader);

        // Predict the condition outcome based on the feed
        const prediction = predictOracleCondition(oracleCondition, feedData, cache);

        // Attach prediction to candidate
        if (!candidate.condition) {
          candidate.condition = {};
        }
        candidate.condition.prediction = {
          claimable: prediction.claimable,
          method: "oracle_feed",
          timestamp: prediction.timestamp,
          details: prediction.details,
        };
        candidate.condition.skipped_simulation = true;

        // If prediction is unmet, mark for skipping
        if (!prediction.claimable) {
          skippedByOraclePrediction.push(candidate.taskId);
        }
      } catch (feedError) {
        // Feed read failed
        if (!fallbackToSimulation) {
          // Treat feed error as unmet condition (conservative approach)
          skippedByOraclePrediction.push(candidate.taskId);
          if (!candidate.condition) {
            candidate.condition = {};
          }
          candidate.condition.prediction = {
            claimable: false,
            method: "unknown",
            timestamp: Math.floor(Date.now() / 1000),
            details: {
              reason: `Feed read failed: ${feedError instanceof Error ? feedError.message : "unknown error"}`,
            },
          };
        }
        // Otherwise: fall through to simulation (condition.prediction remains undefined)
      }
    } catch (decodeError) {
      // Condition decoding failed; skip oracle precheck (will use simulation)
    }
  }

  return {
    candidates,
    cache,
    skippedByOraclePrediction,
  };
}

/**
 * Filter candidates based on oracle predictions, removing those predicted unmet.
 *
 * Used after preCheckOracleConditions to remove unpromising candidates from
 * the ranking pipeline, saving simulation RPC calls.
 *
 * @param candidates - Array of evaluated candidates (some with oracle predictions)
 * @returns Filtered array excluding candidates with unmet oracle predictions
 */
export function filterByOraclePrediction(candidates: EvaluatedCandidate[]): EvaluatedCandidate[] {
  return candidates.filter((candidate) => {
    // If no oracle prediction attached, include candidate (will use simulation)
    if (!candidate.condition?.prediction) {
      return true;
    }

    // Include only if prediction is claimable
    return candidate.condition.prediction.claimable;
  });
}
