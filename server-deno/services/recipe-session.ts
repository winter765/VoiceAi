/**
 * Recipe Session Service
 *
 * Manages recipe navigation sessions for Chef AI with database persistence.
 * Supports step-by-step navigation with context preservation across reconnections.
 */

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { classifyNavigationIntent } from "../prompts/chef.ts";

export interface RecipeSession {
    id: string;
    deviceId: string;
    userId?: string;
    recipeName: string;
    totalSteps: number;
    currentStep: number;
    steps: string[];
    status: "active" | "paused" | "completed";
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
}

interface DbRecipeSession {
    id: string;
    device_id: string;
    user_id: string | null;
    recipe_name: string;
    total_steps: number;
    current_step: number;
    steps: string[];
    status: string;
    created_at: string;
    updated_at: string;
    expires_at: string;
}

// In-memory cache for fast access during active sessions
const sessionCache = new Map<string, RecipeSession>();

/**
 * Get active recipe session for a device
 */
export async function getRecipeSession(
    supabase: SupabaseClient,
    deviceId: string
): Promise<RecipeSession | null> {
    // Check cache first
    const cached = sessionCache.get(deviceId);
    if (cached && cached.status === "active") {
        return cached;
    }

    // Query database
    const { data, error } = await supabase
        .from("recipe_sessions")
        .select("*")
        .eq("device_id", deviceId)
        .eq("status", "active")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

    if (error || !data) {
        return null;
    }

    const session = dbToSession(data as DbRecipeSession);
    sessionCache.set(deviceId, session);
    return session;
}

/**
 * Create a new recipe session
 */
export async function createRecipeSession(
    supabase: SupabaseClient,
    params: {
        deviceId: string;
        userId?: string;
        recipeName: string;
        steps: string[];
    }
): Promise<RecipeSession> {
    const { deviceId, userId, recipeName, steps } = params;

    // Close any existing active session for this device
    await closeActiveSession(supabase, deviceId);

    // Create new session
    const { data, error } = await supabase
        .from("recipe_sessions")
        .insert({
            device_id: deviceId,
            user_id: userId || null,
            recipe_name: recipeName,
            total_steps: steps.length,
            current_step: 1,
            steps: steps,
            status: "active",
            expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2 hours
        })
        .select()
        .single();

    if (error) {
        console.error("[RecipeSession] Error creating session:", error);
        throw new Error(`Failed to create recipe session: ${error.message}`);
    }

    const session = dbToSession(data as DbRecipeSession);
    sessionCache.set(deviceId, session);

    console.log(`[RecipeSession] Created session for ${recipeName} (${steps.length} steps)`);
    return session;
}

/**
 * Update current step in a recipe session
 */
export async function updateRecipeStep(
    supabase: SupabaseClient,
    deviceId: string,
    newStep: number
): Promise<RecipeSession | null> {
    const session = await getRecipeSession(supabase, deviceId);
    if (!session) {
        return null;
    }

    // Validate step bounds
    const step = Math.max(1, Math.min(newStep, session.totalSteps));

    const { data, error } = await supabase
        .from("recipe_sessions")
        .update({
            current_step: step,
            status: step >= session.totalSteps ? "completed" : "active",
        })
        .eq("id", session.id)
        .select()
        .single();

    if (error) {
        console.error("[RecipeSession] Error updating step:", error);
        return null;
    }

    const updated = dbToSession(data as DbRecipeSession);
    sessionCache.set(deviceId, updated);

    console.log(`[RecipeSession] Updated step to ${step}/${session.totalSteps}`);
    return updated;
}

/**
 * Close active session for a device
 */
export async function closeActiveSession(
    supabase: SupabaseClient,
    deviceId: string
): Promise<void> {
    await supabase
        .from("recipe_sessions")
        .update({ status: "completed" })
        .eq("device_id", deviceId)
        .eq("status", "active");

    sessionCache.delete(deviceId);
    console.log(`[RecipeSession] Closed active session for device ${deviceId}`);
}

/**
 * Process navigation command and return the appropriate step content
 * Returns null if no active session or command not recognized as navigation
 */
export async function processNavigationCommand(
    supabase: SupabaseClient,
    deviceId: string,
    userText: string
): Promise<{
    type: "navigation" | "question" | "new_recipe";
    stepContent?: string;
    stepNumber?: number;
    totalSteps?: number;
    recipeName?: string;
} | null> {
    const intent = classifyNavigationIntent(userText);

    // If it's a question or new recipe, let AI handle it
    if (intent === "question") {
        return { type: "question" };
    }
    if (intent === "new_recipe") {
        await closeActiveSession(supabase, deviceId);
        return { type: "new_recipe" };
    }

    // Navigation commands need an active session
    const session = await getRecipeSession(supabase, deviceId);
    if (!session) {
        return null;
    }

    let newStep = session.currentStep;

    switch (intent) {
        case "next":
            newStep = Math.min(session.currentStep + 1, session.totalSteps);
            break;
        case "repeat":
            // Keep same step
            break;
        case "prev":
            newStep = Math.max(session.currentStep - 1, 1);
            break;
        case "jump":
            // Extract step number from text
            const match = userText.match(/\d+/);
            if (match) {
                newStep = Math.max(1, Math.min(parseInt(match[0]), session.totalSteps));
            }
            break;
    }

    // Update step if changed
    if (newStep !== session.currentStep) {
        await updateRecipeStep(supabase, deviceId, newStep);
    }

    return {
        type: "navigation",
        stepContent: session.steps[newStep - 1],
        stepNumber: newStep,
        totalSteps: session.totalSteps,
        recipeName: session.recipeName,
    };
}

/**
 * Get step content for display/TTS without calling AI
 */
export function getStepContent(session: RecipeSession, step?: number): string {
    const stepNum = step || session.currentStep;
    if (stepNum < 1 || stepNum > session.totalSteps) {
        return "";
    }
    return session.steps[stepNum - 1];
}

/**
 * Clean up expired sessions (call periodically)
 */
export async function cleanupExpiredSessions(supabase: SupabaseClient): Promise<number> {
    const { data, error } = await supabase
        .from("recipe_sessions")
        .delete()
        .lt("expires_at", new Date().toISOString())
        .select("id");

    if (error) {
        console.error("[RecipeSession] Error cleaning up expired sessions:", error);
        return 0;
    }

    const count = data?.length || 0;
    if (count > 0) {
        console.log(`[RecipeSession] Cleaned up ${count} expired sessions`);
    }
    return count;
}

// Helper: Convert DB row to RecipeSession
function dbToSession(row: DbRecipeSession): RecipeSession {
    return {
        id: row.id,
        deviceId: row.device_id,
        userId: row.user_id || undefined,
        recipeName: row.recipe_name,
        totalSteps: row.total_steps,
        currentStep: row.current_step,
        steps: row.steps,
        status: row.status as "active" | "paused" | "completed",
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        expiresAt: new Date(row.expires_at),
    };
}
