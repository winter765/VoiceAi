/**
 * Chef AI - System Prompt and Tools Configuration
 *
 * A specialized kitchen AI assistant with recipe navigation,
 * timer management, and cooking guidance capabilities.
 */

// Chef personality key identifier
export const CHEF_PERSONALITY_KEY = "chef";

/**
 * Chef System Prompt Template
 *
 * @param chatHistory - Previous conversation history
 * @param timestamp - Current timestamp
 * @param language - User's preferred language
 * @param activeRecipe - Current recipe session state (optional)
 * @param activeTimers - Current active timers (optional)
 */
export function getChefSystemPrompt(params: {
    chatHistory: string;
    timestamp: string;
    language: string;
    activeRecipe?: {
        name: string;
        currentStep: number;
        totalSteps: number;
    } | null;
    activeTimers?: Array<{
        name: string;
        remainingSeconds: number;
    }>;
}): string {
    const { chatHistory, timestamp, language, activeRecipe, activeTimers } = params;

    // Build active state section
    let activeStateSection = "";
    if (activeRecipe) {
        activeStateSection += `
## Current Recipe Session
You are currently guiding the user through: **${activeRecipe.name}**
Progress: Step ${activeRecipe.currentStep} of ${activeRecipe.totalSteps}
`;
    }
    if (activeTimers && activeTimers.length > 0) {
        const timerList = activeTimers
            .map(t => `- ${t.name}: ${Math.floor(t.remainingSeconds / 60)}m ${t.remainingSeconds % 60}s remaining`)
            .join("\n");
        activeStateSection += `
## Active Timers
${timerList}
`;
    }

    return `# Role: Chef - AI Kitchen Assistant

You are **Chef**, a professional AI kitchen assistant. Your expertise is deeply rooted in American culinary culture, from classic burgers and BBQ to New Orleans Creole flavors and California healthy cuisine.

## Your Expertise
- **American Cuisine Specialist**: Southern fried chicken, Thanksgiving turkey, home baking (apple pie, brownies)
- **Global Cuisine**: Italian pasta, Asian stir-fry, Mexican burritos, French desserts
- **Cooking Techniques**: Temperature control, ingredient substitution, timing management

## Your Personality
- Warm, professional, and encouraging
- Use chef-style expressions and cooking metaphors
- Be patient with beginners, detailed with techniques
- Add personality to timer reminders (e.g., "The eggs are ready, don't let them get old!")

## Strict Limitation
You ONLY discuss cooking-related topics. For ANY non-cooking questions (weather, news, history, tech support, etc.), politely decline using one of these responses:
1. "Hmm, that seems outside my recipe database. I'm best at American and global cooking - how about we talk about what to make for dinner? Maybe a nice BBQ?"
2. "That question is like asking a cheesecake chef to fix a rocket - not my specialty! But if you want to know how to make American BBQ ribs, I'm your expert!"
3. "Sorry, I'm in 'kitchen mode' and focused on recipes. Let's get back to delicious food!"
4. "I'm a culinary AI assistant focused on recipes. I can't answer non-cooking questions. Thank you for understanding."

## Recipe Navigation Rules

When a user requests a recipe:
1. **Save the recipe steps** using the \`save_recipe_steps\` tool
2. **Explain one step at a time** - never dump all steps at once
3. After each step, prompt: "Ready? Say 'next' when you want to continue."

Distinguish three types of user input during recipe navigation:
- **Navigation commands** ("next", "repeat", "previous", "step 3") → Move to the requested step
- **Inserted questions** ("what does that mean?", "how do I know when...") → Answer the question, then say "Okay, ready to continue to the next step?"
- **New recipe requests** ("let's make something else", "how do I make X") → Start fresh with the new recipe

## Timer Rules

When setting a timer:
1. Call the \`set_timer\` tool with the timer details
2. **IMPORTANT**: In your voice response, you MUST say the reminder phrase out loud. Format: "Okay, I'll remind you in X minutes: [reminder_phrase]"
3. The reminder phrase should be chef-style and fun (e.g., "The eggs are done, quick, before they get tough!")

When a user asks about timer status:
- Refer to the Active Timers section above
- If no timers are active, say so

## Language
Default language: ${language}
Switch to any other language if the user requests it.

## Current Time
${timestamp}

${activeStateSection}

## Chat History
${chatHistory}

Remember: You are a kitchen expert. Stay in character, be helpful, and make cooking fun!
`;
}

/**
 * Chef-specific first message prompt
 */
export function getChefFirstMessage(userName?: string): string {
    if (userName) {
        return `Greet ${userName} warmly as Chef, their kitchen AI assistant. Offer to help with recipes, cooking tips, or set kitchen timers. Keep it brief and friendly.`;
    }
    return "Greet the user warmly as Chef, their kitchen AI assistant. Offer to help with recipes, cooking tips, or set kitchen timers. Keep it brief and friendly.";
}

/**
 * Ultravox Tool Definitions for Chef
 */
export const chefTools = [
    {
        temporaryTool: {
            modelToolName: "set_timer",
            description: "Set a kitchen timer. After calling this tool, you MUST say the reminder phrase out loud in your response.",
            dynamicParameters: [
                {
                    name: "timer_name",
                    location: "PARAMETER_LOCATION_BODY",
                    schema: {
                        type: "string",
                        description: "Name of the timer (e.g., 'eggs', 'roast beef', 'pasta')"
                    },
                    required: true
                },
                {
                    name: "duration_seconds",
                    location: "PARAMETER_LOCATION_BODY",
                    schema: {
                        type: "integer",
                        description: "Duration in seconds"
                    },
                    required: true
                },
                {
                    name: "reminder_phrase",
                    location: "PARAMETER_LOCATION_BODY",
                    schema: {
                        type: "string",
                        description: "The reminder phrase to say when timer ends (chef-style, e.g., 'The eggs are done, quick!')"
                    },
                    required: true
                }
            ],
            client: {}  // Client-side tool - handled by our server
        }
    },
    {
        temporaryTool: {
            modelToolName: "cancel_timer",
            description: "Cancel an existing timer by name",
            dynamicParameters: [
                {
                    name: "timer_name",
                    location: "PARAMETER_LOCATION_BODY",
                    schema: {
                        type: "string",
                        description: "Name of the timer to cancel"
                    },
                    required: true
                }
            ],
            client: {}
        }
    },
    {
        temporaryTool: {
            modelToolName: "list_timers",
            description: "List all active timers and their remaining time",
            dynamicParameters: [],
            client: {}
        }
    },
    {
        temporaryTool: {
            modelToolName: "save_recipe_steps",
            description: "Save recipe steps for step-by-step navigation. Call this when starting to explain a new recipe.",
            dynamicParameters: [
                {
                    name: "recipe_name",
                    location: "PARAMETER_LOCATION_BODY",
                    schema: {
                        type: "string",
                        description: "Name of the recipe"
                    },
                    required: true
                },
                {
                    name: "steps",
                    location: "PARAMETER_LOCATION_BODY",
                    schema: {
                        type: "array",
                        items: { type: "string" },
                        description: "Array of recipe steps, each step as a string"
                    },
                    required: true
                }
            ],
            client: {}
        }
    }
];

/**
 * Predefined rejection responses for non-cooking questions
 */
export const rejectionResponses = [
    "Hmm, that question seems outside my recipe database. I'm best at American and global cooking - how about we talk about what to make for dinner? Maybe a nice BBQ?",
    "That question is like asking a chef who makes perfect New York cheesecake to fix a rocket - not my expertise! But if you want to know how to make American BBQ ribs, I'm your expert!",
    "Sorry, my programming is set to 'kitchen mode', especially focused on American and global recipes. I might not be able to give you an accurate answer on other topics. Let's focus back on delicious food!",
    "I'm an AI assistant focused on American and global recipes. I can't answer questions unrelated to cooking. Thank you for understanding."
];

/**
 * Intent classification for recipe navigation
 * Returns the intent type based on user input
 */
export function classifyNavigationIntent(text: string): "next" | "repeat" | "prev" | "jump" | "question" | "new_recipe" {
    const normalized = text.toLowerCase().trim();

    // Navigation commands
    if (/^(next|下一步|continue|go on|then what|继续|然后呢)$/i.test(normalized)) {
        return "next";
    }
    if (/^(repeat|again|say that again|重复|再说一遍|pardon|what\?|huh\?)$/i.test(normalized)) {
        return "repeat";
    }
    if (/^(previous|back|go back|上一步|返回|before that)$/i.test(normalized)) {
        return "prev";
    }
    if (/^(step\s*\d+|第\s*\d+\s*步)$/i.test(normalized)) {
        return "jump";
    }

    // New recipe detection
    if (/(how (do i|to) make|recipe for|teach me|做法|怎么做|食谱)/i.test(normalized) && normalized.length > 15) {
        return "new_recipe";
    }
    if (/(let's make something else|different recipe|换个菜|做别的)/i.test(normalized)) {
        return "new_recipe";
    }

    // Default to question (inserted question during recipe)
    return "question";
}
