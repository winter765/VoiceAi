/**
 * SessionManager - 集中管理所有活跃的 Ultravox 会话
 *
 * 功能：
 * - 按设备 ID 管理会话
 * - 新连接时自动清理旧会话
 * - 提供 API 查询和强制关闭
 */

import { WebSocket } from "npm:ws";

// 会话最大时长：30 分钟
const SESSION_MAX_DURATION_MS = 30 * 60 * 1000;
// 超时检查间隔：1 分钟
const TIMEOUT_CHECK_INTERVAL_MS = 60 * 1000;

export interface Session {
    deviceId: string;
    callId: string | null;
    ws: WebSocket;           // ESP32 WebSocket
    uvWs: WebSocket | null;  // Ultravox WebSocket
    createdAt: Date;
    lastActivity: Date;
    cleanup: () => void;     // 清理函数，由 handler 提供
}

export interface SessionInfo {
    deviceId: string;
    callId: string | null;
    createdAt: string;
    lastActivity: string;
    durationMs: number;
    hasUltravoxConnection: boolean;
}

class SessionManager {
    private sessions: Map<string, Session> = new Map();
    private timeoutChecker: ReturnType<typeof setInterval> | null = null;

    /**
     * 注册新会话
     * 如果该设备已有旧会话，先关闭旧会话
     */
    register(deviceId: string, session: Omit<Session, 'createdAt' | 'lastActivity'>): void {
        // 检查是否有旧会话
        const existing = this.sessions.get(deviceId);
        if (existing) {
            console.log(`[SessionManager] Device ${deviceId} has existing session, closing it first`);
            this.forceClose(deviceId);
        }

        const fullSession: Session = {
            ...session,
            createdAt: new Date(),
            lastActivity: new Date(),
        };

        this.sessions.set(deviceId, fullSession);
        console.log(`[SessionManager] Registered session for device ${deviceId}, total sessions: ${this.sessions.size}`);
    }

    /**
     * 注销会话
     */
    unregister(deviceId: string): void {
        if (this.sessions.delete(deviceId)) {
            console.log(`[SessionManager] Unregistered session for device ${deviceId}, total sessions: ${this.sessions.size}`);
        }
    }

    /**
     * 获取会话
     */
    get(deviceId: string): Session | undefined {
        return this.sessions.get(deviceId);
    }

    /**
     * 获取所有会话信息（用于 API）
     */
    getAll(): SessionInfo[] {
        const now = new Date();
        return Array.from(this.sessions.values()).map(session => ({
            deviceId: session.deviceId,
            callId: session.callId,
            createdAt: session.createdAt.toISOString(),
            lastActivity: session.lastActivity.toISOString(),
            durationMs: now.getTime() - session.createdAt.getTime(),
            hasUltravoxConnection: session.uvWs !== null && session.uvWs.readyState === WebSocket.OPEN,
        }));
    }

    /**
     * 强制关闭指定设备的会话
     */
    forceClose(deviceId: string): boolean {
        const session = this.sessions.get(deviceId);
        if (!session) {
            console.log(`[SessionManager] No session found for device ${deviceId}`);
            return false;
        }

        console.log(`[SessionManager] Force closing session for device ${deviceId}`);

        // 调用 handler 提供的清理函数
        try {
            session.cleanup();
        } catch (e) {
            console.error(`[SessionManager] Error during cleanup for device ${deviceId}:`, e);
        }

        this.sessions.delete(deviceId);
        return true;
    }

    /**
     * 关闭所有会话
     */
    closeAll(): number {
        const count = this.sessions.size;
        console.log(`[SessionManager] Closing all ${count} sessions`);

        for (const [deviceId, session] of this.sessions) {
            try {
                session.cleanup();
            } catch (e) {
                console.error(`[SessionManager] Error during cleanup for device ${deviceId}:`, e);
            }
        }

        this.sessions.clear();
        return count;
    }

    /**
     * 更新会话的 Ultravox 信息
     */
    updateUltravoxInfo(deviceId: string, callId: string, uvWs: WebSocket): void {
        const session = this.sessions.get(deviceId);
        if (session) {
            session.callId = callId;
            session.uvWs = uvWs;
            session.lastActivity = new Date();
        }
    }

    /**
     * 更新最后活动时间
     */
    updateActivity(deviceId: string): void {
        const session = this.sessions.get(deviceId);
        if (session) {
            session.lastActivity = new Date();
        }
    }

    /**
     * 获取会话数量
     */
    get count(): number {
        return this.sessions.size;
    }

    /**
     * 启动超时检查器
     * 定期检查并关闭超过最大时长的会话
     */
    startTimeoutChecker(): void {
        if (this.timeoutChecker) {
            return; // 已经在运行
        }

        console.log(`[SessionManager] Starting timeout checker (max duration: ${SESSION_MAX_DURATION_MS / 1000 / 60} minutes)`);

        this.timeoutChecker = setInterval(() => {
            this.checkTimeouts();
        }, TIMEOUT_CHECK_INTERVAL_MS);
    }

    /**
     * 停止超时检查器
     */
    stopTimeoutChecker(): void {
        if (this.timeoutChecker) {
            clearInterval(this.timeoutChecker);
            this.timeoutChecker = null;
            console.log("[SessionManager] Timeout checker stopped");
        }
    }

    /**
     * 检查并关闭超时会话
     */
    private checkTimeouts(): void {
        const now = Date.now();
        const expiredDevices: string[] = [];

        for (const [deviceId, session] of this.sessions) {
            const durationMs = now - session.createdAt.getTime();
            if (durationMs > SESSION_MAX_DURATION_MS) {
                console.log(`[SessionManager] Session for device ${deviceId} exceeded max duration (${Math.round(durationMs / 1000 / 60)} minutes), closing`);
                expiredDevices.push(deviceId);
            }
        }

        for (const deviceId of expiredDevices) {
            this.forceClose(deviceId);
        }

        if (expiredDevices.length > 0) {
            console.log(`[SessionManager] Closed ${expiredDevices.length} expired sessions`);
        }
    }
}

// 导出单例
export const sessionManager = new SessionManager();
