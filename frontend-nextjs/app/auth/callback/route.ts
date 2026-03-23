import { createUser, doesUserExist } from "@/db/users";
import { addUserToDeviceByMac } from "@/db/devices";
import { createClient } from "@/utils/supabase/server";
import { NextResponse } from "next/server";
import { defaultPersonalityId, defaultToyId } from "@/lib/data";
import { getBaseUrl } from "@/lib/utils";

export async function GET(request: Request) {
    // The `/auth/callback` route is required for the server-side auth flow implemented
    // by the SSR package. It exchanges an auth code for the user's session.
    // https://supabase.com/docs/guides/auth/server-side/nextjs
    const requestUrl = new URL(request.url);
    const code = requestUrl.searchParams.get("code");
    const mac = requestUrl.searchParams.get("mac");

    const origin = getBaseUrl();

    if (code) {
        const supabase = createClient();
        await supabase.auth.exchangeCodeForSession(code);
        const {
            data: { user },
        } = await supabase.auth.getUser();

        if (user) {
            const userExists = await doesUserExist(supabase, user);
            if (!userExists) {
                // Create user if they don't exist
                await createUser(supabase, user, {
                    language_code: "en-US",
                    personality_id:
                        user?.user_metadata?.personality_id ??
                        defaultPersonalityId,
                });

                // Auto-bind device if mac parameter is present
                if (mac) {
                    await addUserToDeviceByMac(supabase, mac, user.id);
                }

                return NextResponse.redirect(`${origin}/onboard`);
            }

            // Existing user — still auto-bind device if mac present and not yet bound
            if (mac) {
                await addUserToDeviceByMac(supabase, mac, user.id);
            }
        }
    }

    // URL to redirect to after sign up process completes
    return NextResponse.redirect(`${origin}/home`);
}
