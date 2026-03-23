import Link from "next/link";
import { headers } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import { SubmitButton } from "../login/submit-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Sparkles } from "lucide-react";
import { Label } from "@/components/ui/label";
import GoogleLoginButton from "../../components/GoogleLoginButton";

interface RegisterProps {
  searchParams?: { [key: string]: string | string[] | undefined };
}

export default async function Register({ searchParams }: RegisterProps) {
  const mac = searchParams?.mac as string | undefined;
  const isGoogleOAuthEnabled = process.env.GOOGLE_OAUTH === "True";

  const signUpAction = async (formData: FormData) => {
    "use server";

    const email = formData.get("email") as string;
    const password = formData.get("password") as string;
    const macAddress = formData.get("mac") as string | null;
    const supabase = createClient();
    const origin = headers().get("origin");

    const callbackUrl = macAddress
      ? `${origin}/auth/callback?mac=${encodeURIComponent(macAddress)}`
      : `${origin}/auth/callback`;

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: callbackUrl,
      },
    });

    if (error) {
      return redirect(
        `/register?message=${encodeURIComponent(error.message)}${macAddress ? `&mac=${encodeURIComponent(macAddress)}` : ""}`
      );
    }

    // If email confirmation is disabled, user is already logged in
    if (data?.session) {
      // Auto-bind device if mac parameter is present
      if (macAddress) {
        const { addUserToDeviceByMac } = await import("@/db/devices");
        await addUserToDeviceByMac(supabase, macAddress, data.user!.id);
      }

      // Create user record in public.users if needed
      const { doesUserExist, createUser } = await import("@/db/users");
      const { defaultPersonalityId } = await import("@/lib/data");
      const userExists = await doesUserExist(supabase, data.user!);
      if (!userExists) {
        await createUser(supabase, data.user!, {
          language_code: "en-US",
          personality_id: defaultPersonalityId,
        });
      }

      return redirect(macAddress ? `/onboard?mac=${encodeURIComponent(macAddress)}` : "/onboard");
    }

    // Email confirmation required — show message
    return redirect(
      `/register?message=${encodeURIComponent("Check email to continue sign up process")}${macAddress ? `&mac=${encodeURIComponent(macAddress)}` : ""}`
    );
  };

  return (
    <div className="flex-1 flex flex-col w-full px-8 sm:max-w-md justify-center gap-2">
      <Card className="shadow-md sm:bg-white bg-transparent shadow-none">
        <CardHeader>
          <CardTitle className="flex flex-row gap-1 items-center">
            Register for Elato
            <Sparkles size={20} fill="black" />
          </CardTitle>
          <CardDescription>
            Create a new account to get started
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {isGoogleOAuthEnabled && (
            <GoogleLoginButton
              toy_id={undefined}
              personality_id={undefined}
            />
          )}

          <form className="flex-1 flex flex-col w-full justify-center gap-4">
            {mac && <input type="hidden" name="mac" value={mac} />}

            <Label className="text-md" htmlFor="email">
              Email
            </Label>
            <input
              className="rounded-md px-4 py-2 bg-inherit border"
              name="email"
              placeholder="you@example.com"
              required
            />
            <Label className="text-md" htmlFor="password">
              Password
            </Label>
            <input
              className="rounded-md px-4 py-2 bg-inherit border"
              type="password"
              name="password"
              placeholder="••••••••"
              minLength={6}
              required
            />

            <SubmitButton
              formAction={signUpAction}
              className="text-sm font-medium bg-gray-100 hover:bg-gray-50 dark:text-stone-900 border-[0.1px] rounded-md px-4 py-2 text-foreground my-2"
              pendingText="Signing Up..."
            >
              Sign Up
            </SubmitButton>

            {mac && (
              <p className="text-xs text-gray-500 text-center">
                Device ({mac}) will be automatically bound to your account after registration.
              </p>
            )}

            {searchParams?.message && (
              <p className="p-4 rounded-md border bg-green-50 border-green-400 text-gray-900 text-center text-sm">
                {searchParams.message}
              </p>
            )}

            <p className="text-sm text-center text-gray-500">
              Already have an account?{" "}
              <Link href={mac ? `/login?mac=${encodeURIComponent(mac)}` : "/login"} className="text-foreground underline">
                Login
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
