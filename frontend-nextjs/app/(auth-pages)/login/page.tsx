import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import { SubmitButton } from "./submit-button";
import { Separator } from "@/components/ui/separator";
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

interface LoginProps {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function Login({ searchParams }: LoginProps) {
  const params = await searchParams;
  const toy_id = params?.toy_id as string | undefined;
  const personality_id = params?.personality_id as string | undefined;
  const mac = params?.mac as string | undefined;
  const isGoogleOAuthEnabled = process.env.GOOGLE_OAUTH === "True";

  const signInAction = async (formData: FormData) => {
    "use server";

    const email = formData.get("email") as string;
    const password = formData.get("password") as string;
    const macAddress = formData.get("mac") as string | null;
    const supabase = createClient();

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return redirect(
        `/login?message=${encodeURIComponent(error.message)}${macAddress ? `&mac=${encodeURIComponent(macAddress)}` : ""}`
      );
    }

    // Auto-bind device if mac parameter is present
    if (macAddress && data?.user) {
      const { addUserToDeviceByMac } = await import("@/db/devices");
      await addUserToDeviceByMac(supabase, macAddress, data.user.id);
    }

    return redirect("/home");
  };

  return (
    <div className="flex-1 flex flex-col w-full px-8 sm:max-w-md justify-center gap-2">
      <Card className="bg-white shadow-md">
        <CardHeader>
          <CardTitle className="flex flex-row gap-1 items-center">
            Login to Elato
            <Sparkles size={20} fill="black" />
          </CardTitle>
          <CardDescription>
            Sign in to your account to continue
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {isGoogleOAuthEnabled && (
            <GoogleLoginButton
              toy_id={toy_id}
              personality_id={personality_id}
            />
          )}

           <Separator className="mt-2" />
           <span className="text-sm text-gray-500">If you've got your DB running locally, you can login with: <br/><span className="font-bold">Email</span> admin@elatoai.com<br /><span className="font-bold">Password</span> admin</span>

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
              required
            />

            <Link
              className="text-xs text-foreground underline"
              href="/forgot-password"
            >
              Forgot Password?
            </Link>

            <SubmitButton
              formAction={signInAction}
              className="text-sm font-medium bg-gray-100 hover:bg-gray-50 dark:text-stone-900 border-[0.1px] rounded-md px-4 py-2 text-foreground my-2"
              pendingText="Signing In..."
            >
              Sign In
            </SubmitButton>
            {params?.message && (
              <p className="p-4 rounded-md border bg-red-50 border-red-400 text-gray-900 text-center text-sm">
                {params.message}
              </p>
            )}

            {mac && (
              <p className="text-xs text-gray-500 text-center">
                Device ({mac}) will be automatically bound to your account after login.
              </p>
            )}

            <p className="text-sm text-center text-gray-500">
              Don't have an account?{" "}
              <Link href={mac ? `/register?mac=${encodeURIComponent(mac)}` : "/register"} className="text-foreground underline">
                Register
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
