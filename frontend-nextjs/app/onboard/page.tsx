import { createClient } from "@/utils/supabase/server";
import Steps from "../components/Onboarding/Steps";
import { Suspense } from "react";

export default async function Home() {
    const supabase = createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();

    return (
        <div className="flex flex-col gap-2">
            <Suspense>
                <Steps userId={user?.id ?? ""} />
            </Suspense>
        </div>
    );
}
