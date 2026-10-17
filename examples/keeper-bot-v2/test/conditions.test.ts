/**
 * Tests for oracle condition evaluation and prediction (issue #0426)
 *
 * Validates:
 * 1. Oracle feed caching (reads each feed once per round)
 * 2. Condition prediction accuracy against oracle feed prices
 * 3. Mismatch detection and logging
 * 4. Fallback behavior when feed reads fail
 * 5. Prediction validation against on-chain results
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  OracleFeedCache,
  decodeOracleCondition,
  evaluateOracleCondition,
  predictOracleCondition,
  validatePrediction,
  validatePredictionAgainstActual,
  type OracleFeedData,
  type OraclePriceThresholdCondition,
  type ConditionMismatch,
} from "../src/conditions.js";
import { OracleConditionLogger, validateAndLogPrediction } from "../src/oracle-logger.js";

describe("OracleFeedCache", () => {
  let cache: OracleFeedCache;

  beforeEach(() => {
    cache = new OracleFeedCache();
  });

  it("caches feeds by feed ID, reading each only once", async () => {
    const feedId = { base: "BTC", quote: "USD" };
    const mockFeedData: OracleFeedData = {
      feedId,
      price: 50000n,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    };

    let readCount = 0;
    const reader = async () => {
      readCount++;
      return mockFeedData;
    };

    // First read should call reader
    const result1 = await cache.getFeed(feedId, reader);
    expect(readCount).toBe(1);
    expect(result1.price).toBe(50000n);

    // Second read should use cache
    const result2 = await cache.getFeed(feedId, reader);
    expect(readCount).toBe(1); // Still 1, not incremented
    expect(result2.price).toBe(50000n);
  });

  it("caches different feeds separately", async () => {
    const btcFeed = { base: "BTC", quote: "USD" };
    const ethFeed = { base: "ETH", quote: "USD" };

    const btcData: OracleFeedData = {
      feedId: btcFeed,
      price: 50000n,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    };

    const ethData: OracleFeedData = {
      feedId: ethFeed,
      price: 3000n,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    };

    let btcReads = 0;
    let ethReads = 0;

    const reader = async (feedId: any) => {
      if (feedId.base === "BTC") {
        btcReads++;
        return btcData;
      } else {
        ethReads++;
        return ethData;
      }
    };

    // Read each feed once
    const btcResult = await cache.getFeed(btcFeed, reader);
    const ethResult = await cache.getFeed(ethFeed, reader);

    expect(btcReads).toBe(1);
    expect(ethReads).toBe(1);
    expect(btcResult.price).toBe(50000n);
    expect(ethResult.price).toBe(3000n);

    // Read again; should use cache
    await cache.getFeed(btcFeed, reader);
    await cache.getFeed(ethFeed, reader);

    expect(btcReads).toBe(1); // Still 1
    expect(ethReads).toBe(1); // Still 1
  });

  it("tracks cache statistics", async () => {
    const feedId1 = { base: "BTC", quote: "USD" };
    const feedId2 = { base: "ETH", quote: "USD" };

    const mockData = (feed: any): OracleFeedData => ({
      feedId: feed,
      price: 1000n,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    });

    const reader = async (feedId: any) => mockData(feedId);

    await cache.getFeed(feedId1, reader);
    await cache.getFeed(feedId2, reader);

    const stats = cache.getStats();
    expect(stats.distinctFeeds).toBe(2);
    expect(stats.totalReads).toBe(2);
    expect(stats.mismatches).toBe(0);
  });

  it("records mismatches", () => {
    const mismatch: ConditionMismatch = {
      taskId: 123n,
      feedId: { base: "BTC", quote: "USD" },
      predicted: true,
      actual: false,
      timestamp: Math.floor(Date.now() / 1000),
      description: "Prediction disagreed with on-chain result",
    };

    cache.recordMismatch(mismatch);

    const mismatches = cache.getMismatches();
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toEqual(mismatch);
  });

  it("resets cache between rounds", async () => {
    const feedId = { base: "BTC", quote: "USD" };
    const mockData: OracleFeedData = {
      feedId,
      price: 50000n,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    };

    let readCount = 0;
    const reader = async () => {
      readCount++;
      return mockData;
    };

    // First round: read once
    await cache.getFeed(feedId, reader);
    expect(readCount).toBe(1);

    // Reset for next round
    cache.reset();

    // Second round: should read again
    await cache.getFeed(feedId, reader);
    expect(readCount).toBe(2);
  });
});

describe("Oracle Condition Evaluation", () => {
  const feedId = { base: "BTC", quote: "USD" };

  it("evaluates above direction correctly", () => {
    const condition: OraclePriceThresholdCondition = {
      feedId,
      threshold: 50000n,
      direction: "above",
      decimals: 8,
    };

    const feedAbove: OracleFeedData = {
      feedId,
      price: 51000n,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    };

    const feedBelow: OracleFeedData = {
      feedId,
      price: 49000n,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    };

    expect(evaluateOracleCondition(condition, feedAbove)).toBe(true);
    expect(evaluateOracleCondition(condition, feedBelow)).toBe(false);
  });

  it("evaluates below direction correctly", () => {
    const condition: OraclePriceThresholdCondition = {
      feedId,
      threshold: 50000n,
      direction: "below",
      decimals: 8,
    };

    const feedAbove: OracleFeedData = {
      feedId,
      price: 51000n,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    };

    const feedBelow: OracleFeedData = {
      feedId,
      price: 49000n,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    };

    expect(evaluateOracleCondition(condition, feedBelow)).toBe(true);
    expect(evaluateOracleCondition(condition, feedAbove)).toBe(false);
  });

  it("evaluates threshold boundaries correctly", () => {
    const condition: OraclePriceThresholdCondition = {
      feedId,
      threshold: 50000n,
      direction: "above",
      decimals: 8,
    };

    const feedAtThreshold: OracleFeedData = {
      feedId,
      price: 50000n,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    };

    // At threshold should be claimable for "above" direction
    expect(evaluateOracleCondition(condition, feedAtThreshold)).toBe(true);
  });
});

describe("Oracle Condition Prediction", () => {
  const feedId = { base: "BTC", quote: "USD" };

  it("predicts claimable condition correctly", () => {
    const condition: OraclePriceThresholdCondition = {
      feedId,
      threshold: 50000n,
      direction: "above",
      decimals: 8,
    };

    const feedData: OracleFeedData = {
      feedId,
      price: 55000n,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    };

    const prediction = predictOracleCondition(condition, feedData);

    expect(prediction.claimable).toBe(true);
    expect(prediction.prediction_method).toBe("oracle_feed");
    expect(prediction.details?.feed_price).toBe(55000n);
    expect(prediction.details?.threshold).toBe(50000n);
  });

  it("predicts unclaimable condition correctly", () => {
    const condition: OraclePriceThresholdCondition = {
      feedId,
      threshold: 50000n,
      direction: "above",
      decimals: 8,
    };

    const feedData: OracleFeedData = {
      feedId,
      price: 45000n,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    };

    const prediction = predictOracleCondition(condition, feedData);

    expect(prediction.claimable).toBe(false);
    expect(prediction.prediction_method).toBe("oracle_feed");
    expect(prediction.details?.reason).toContain("<");
  });

  it("includes descriptive reasons in predictions", () => {
    const condition: OraclePriceThresholdCondition = {
      feedId,
      threshold: 50000n,
      direction: "above",
      decimals: 8,
    };

    const feedData: OracleFeedData = {
      feedId,
      price: 55000n,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    };

    const prediction = predictOracleCondition(condition, feedData);

    expect(prediction.details?.reason).toContain("55000");
    expect(prediction.details?.reason).toContain("50000");
    expect(prediction.details?.reason).toContain(">=");
  });
});

describe("Prediction Validation", () => {
  it("validates well-formed predictions", () => {
    const prediction = {
      claimable: true,
      prediction_method: "oracle_feed" as const,
      timestamp: Math.floor(Date.now() / 1000),
      details: { feed_price: 50000n },
    };

    const error = validatePrediction(prediction);
    expect(error).toBeUndefined();
  });

  it("rejects predictions with invalid timestamps", () => {
    const prediction = {
      claimable: true,
      prediction_method: "oracle_feed" as const,
      timestamp: 0,
      details: { feed_price: 50000n },
    };

    const error = validatePrediction(prediction);
    expect(error).toBeDefined();
    expect(error).toContain("invalid timestamp");
  });

  it("rejects oracle_feed predictions without feed_price", () => {
    const prediction = {
      claimable: true,
      prediction_method: "oracle_feed" as const,
      timestamp: Math.floor(Date.now() / 1000),
      details: {},
    };

    const error = validatePrediction(prediction);
    expect(error).toBeDefined();
    expect(error).toContain("feed_price");
  });

  it("validates prediction against actual outcome", () => {
    const resultMatch = validatePredictionAgainstActual(123n, true, true);
    expect(resultMatch.matches).toBe(true);
    expect(resultMatch.mismatchReason).toBeUndefined();

    const resultMismatch = validatePredictionAgainstActual(123n, true, false);
    expect(resultMismatch.matches).toBe(false);
    expect(resultMismatch.mismatchReason).toBeDefined();
    expect(resultMismatch.mismatchReason).toContain("true");
    expect(resultMismatch.mismatchReason).toContain("false");
  });
});

describe("OracleConditionLogger", () => {
  let logger: OracleConditionLogger;
  let logCalls: string[];

  beforeEach(() => {
    logCalls = [];
    const mockLog = (message: string) => logCalls.push(message);
    logger = new OracleConditionLogger(mockLog);
  });

  it("logs prediction mismatches", () => {
    const mismatch: ConditionMismatch = {
      taskId: 123n,
      feedId: { base: "BTC", quote: "USD" },
      predicted: true,
      actual: false,
      timestamp: Math.floor(Date.now() / 1000),
      description: "Prediction disagreed with on-chain result",
    };

    logger.logMismatch(mismatch);

    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toContain("WARN");
    expect(logCalls[0]).toContain("mismatch");
    expect(logCalls[0]).toContain("123");
  });

  it("logs fallbacks to simulation", () => {
    logger.logFallbackToSimulation(123n, "BTC/USD", "Connection timeout");

    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toContain("Fallback");
    expect(logCalls[0]).toContain("123");
    expect(logCalls[0]).toContain("timeout");
  });

  it("logs feed errors", () => {
    logger.logFeedError("BTC/USD", new Error("Feed unavailable"));

    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toContain("WARN");
    expect(logCalls[0]).toContain("Feed read error");
    expect(logCalls[0]).toContain("BTC/USD");
  });

  it("tracks statistics correctly", () => {
    const mismatch: ConditionMismatch = {
      taskId: 123n,
      feedId: { base: "BTC", quote: "USD" },
      predicted: true,
      actual: false,
      timestamp: Math.floor(Date.now() / 1000),
      description: "Test",
    };

    logger.logMismatch(mismatch);
    logger.logFallbackToSimulation(124n, "BTC/USD", "Error");
    logger.logFeedSuccess("BTC/USD", 50);
    logger.logFeedError("ETH/USD", "Error");

    const stats = logger.getStats();
    expect(stats.totalEvents).toBe(4);
    expect(stats.mismatches).toBe(1);
    expect(stats.fallbacks).toBe(1);
    expect(stats.feedSuccesses).toBe(1);
    expect(stats.feedErrors).toBe(1);
    expect(stats.feedErrorRate).toBeCloseTo(50);
  });

  it("resets between rounds", () => {
    logger.logFallbackToSimulation(123n, "BTC/USD", "Error");

    let stats = logger.getStats();
    expect(stats.totalEvents).toBe(1);

    logger.reset();

    stats = logger.getStats();
    expect(stats.totalEvents).toBe(0);
  });

  it("generates summary reports", () => {
    const mismatch: ConditionMismatch = {
      taskId: 123n,
      feedId: { base: "BTC", quote: "USD" },
      predicted: true,
      actual: false,
      timestamp: Math.floor(Date.now() / 1000),
      description: "Test",
    };

    logger.logMismatch(mismatch);
    logger.logFeedError("BTC/USD", "Error1");
    logger.logFeedError("ETH/USD", "Error2");
    logger.logFeedSuccess("BTC/USD", 50);

    const report = logger.getSummaryReport();

    expect(report).toContain("Summary");
    expect(report).toContain("Prediction mismatches: 1");
    expect(report).toContain("Feed errors: 2");
    expect(report).toContain("ALERT");
  });

  it("validates and logs predictions", () => {
    validateAndLogPrediction(123n, "BTC/USD", true, false, logger);

    const events = logger.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("mismatch");
  });
});

describe("Condition Decoding Stubs", () => {
  it("returns undefined for undecodable conditions", () => {
    const calldata = Buffer.from([0x01, 0x02, 0x03]);
    const condition = decodeOracleCondition(calldata);
    expect(condition).toBeUndefined();
  });
});
