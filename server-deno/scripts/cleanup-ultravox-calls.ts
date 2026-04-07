#!/usr/bin/env -S deno run -A --env-file=.env
/**
 * Ultravox 会话清理脚本
 *
 * 功能：查询 Ultravox API 中的活跃 calls，终止超时的会话
 *
 * 使用方法：
 *   deno run -A --env-file=.env scripts/cleanup-ultravox-calls.ts
 *
 * 可配置环境变量：
 *   ULTRAVOX_API_KEY - Ultravox API Key（必需）
 *   CLEANUP_MAX_DURATION_MINUTES - 最大会话时长，默认 30 分钟
 *   CLEANUP_DRY_RUN - 设为 "true" 时只打印不执行终止
 */

const ULTRAVOX_API_BASE = "https://api.ultravox.ai/api";
const API_KEY = Deno.env.get("ULTRAVOX_API_KEY");
const MAX_DURATION_MINUTES = parseInt(Deno.env.get("CLEANUP_MAX_DURATION_MINUTES") || "30");
const DRY_RUN = Deno.env.get("CLEANUP_DRY_RUN") === "true";

interface UltravoxCall {
    callId: string;
    created: string;
    ended?: string;
    endReason?: string;
    model?: string;
    systemPrompt?: string;
    [key: string]: unknown;
}

interface ListCallsResponse {
    results: UltravoxCall[];
    next?: string;
    previous?: string;
    count?: number;
}

async function listCalls(): Promise<UltravoxCall[]> {
    const allCalls: UltravoxCall[] = [];
    let url: string | null = `${ULTRAVOX_API_BASE}/calls`;

    while (url) {
        const response = await fetch(url, {
            headers: {
                "X-API-Key": API_KEY!,
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to list calls: ${response.status} ${await response.text()}`);
        }

        const data: ListCallsResponse = await response.json();
        allCalls.push(...data.results);
        url = data.next || null;
    }

    return allCalls;
}

async function endCall(callId: string): Promise<boolean> {
    const response = await fetch(`${ULTRAVOX_API_BASE}/calls/${callId}`, {
        method: "DELETE",
        headers: {
            "X-API-Key": API_KEY!,
        },
    });

    if (!response.ok) {
        console.error(`  Failed to end call ${callId}: ${response.status}`);
        return false;
    }

    return true;
}

function formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

async function main() {
    if (!API_KEY) {
        console.error("Error: ULTRAVOX_API_KEY is not set");
        Deno.exit(1);
    }

    console.log(`[Cleanup] Starting Ultravox call cleanup`);
    console.log(`[Cleanup] Max duration: ${MAX_DURATION_MINUTES} minutes`);
    console.log(`[Cleanup] Dry run: ${DRY_RUN}`);
    console.log();

    // 获取所有 calls
    const calls = await listCalls();
    console.log(`[Cleanup] Found ${calls.length} total calls`);

    // 筛选活跃且超时的 calls
    const now = Date.now();
    const maxDurationMs = MAX_DURATION_MINUTES * 60 * 1000;
    const activeCalls = calls.filter(call => !call.ended);
    const expiredCalls = activeCalls.filter(call => {
        const createdAt = new Date(call.created).getTime();
        return (now - createdAt) > maxDurationMs;
    });

    console.log(`[Cleanup] Active calls: ${activeCalls.length}`);
    console.log(`[Cleanup] Expired calls (>${MAX_DURATION_MINUTES}min): ${expiredCalls.length}`);
    console.log();

    if (expiredCalls.length === 0) {
        console.log("[Cleanup] No expired calls to clean up");
        return;
    }

    // 打印超时会话详情
    console.log("[Cleanup] Expired calls:");
    for (const call of expiredCalls) {
        const createdAt = new Date(call.created).getTime();
        const duration = now - createdAt;
        console.log(`  - ${call.callId}: ${formatDuration(duration)} (created: ${call.created})`);
    }
    console.log();

    // 终止超时会话
    if (DRY_RUN) {
        console.log("[Cleanup] DRY RUN - Skipping termination");
        return;
    }

    let terminated = 0;
    let failed = 0;

    for (const call of expiredCalls) {
        console.log(`[Cleanup] Terminating call ${call.callId}...`);
        const success = await endCall(call.callId);
        if (success) {
            terminated++;
            console.log(`  OK`);
        } else {
            failed++;
        }
    }

    console.log();
    console.log(`[Cleanup] Done. Terminated: ${terminated}, Failed: ${failed}`);
}

main().catch(err => {
    console.error("[Cleanup] Error:", err);
    Deno.exit(1);
});
