
"use client";

import { Progress } from "@/components/ui/progress";
import React, { useState, useEffect } from "react";
import GeneralUserForm from "../Settings/UserForm";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { updateUser } from "@/db/users";
import { Loader2 } from "lucide-react";
import { connectUserToDevice, connectUserToDeviceByMacAction } from "@/app/actions";

const TOTAL_STEPS = 3;

const DeviceBindingStep: React.FC<{
    userId: string;
    initialMac?: string | null;
    onNext: () => void;
}> = ({ userId, initialMac, onNext }) => {
    const supabase = createClient();
    const [bindingMode, setBindingMode] = useState<"mac" | "code">("mac");
    const [inputValue, setInputValue] = useState(initialMac || "");
    const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
    const [message, setMessage] = useState("");

    useEffect(() => {
        // If mac was passed via URL, device was already bound during registration — auto-skip
        if (initialMac) {
            setInputValue(initialMac);
            setStatus("success");
            setMessage("Device already bound!");
            setTimeout(onNext, 800);
            return;
        }
        // Check if user already has a device bound
        const checkExisting = async () => {
            const { data } = await supabase
                .from("users")
                .select("device_id")
                .eq("id", userId)
                .single();
            if (data?.device_id) {
                setStatus("success");
                setMessage("Device already connected!");
                setTimeout(onNext, 800);
            }
        };
        checkExisting();
    }, [initialMac]);

    const handleBind = async () => {
        if (!inputValue.trim()) return;
        setStatus("loading");
        try {
            let success = false;
            if (bindingMode === "mac") {
                success = await connectUserToDeviceByMacAction(userId, inputValue.trim());
            } else {
                success = await connectUserToDevice(userId, inputValue.trim());
            }
            if (success) {
                setStatus("success");
                setMessage("Device bound successfully!");
                setTimeout(onNext, 1000);
            } else {
                setStatus("error");
                setMessage(bindingMode === "mac" ? "Device not found or already bound." : "Invalid device code.");
            }
        } catch {
            setStatus("error");
            setMessage("Failed to bind device.");
        }
    };

    return (
        <div className="flex flex-col gap-4 mt-4">
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={() => setBindingMode("mac")}
                    className={`px-3 py-1 rounded-md text-sm ${bindingMode === "mac" ? "bg-gray-800 text-white" : "bg-gray-100"}`}
                >
                    MAC Address
                </button>
                <button
                    type="button"
                    onClick={() => setBindingMode("code")}
                    className={`px-3 py-1 rounded-md text-sm ${bindingMode === "code" ? "bg-gray-800 text-white" : "bg-gray-100"}`}
                >
                    Device Code
                </button>
            </div>

            <input
                className="rounded-md px-4 py-2 border"
                placeholder={bindingMode === "mac" ? "XX:XX:XX:XX:XX:XX" : "e.g. A3B7K9"}
                value={inputValue}
                onChange={(e) => { setInputValue(e.target.value); setStatus("idle"); }}
            />

            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={handleBind}
                    disabled={status === "loading" || !inputValue.trim()}
                    className="flex-1 px-4 py-2 bg-gray-800 text-white rounded-md text-sm disabled:opacity-50"
                >
                    {status === "loading" ? "Binding..." : "Bind Device"}
                </button>
                <button
                    type="button"
                    onClick={onNext}
                    className="px-4 py-2 bg-gray-100 rounded-md text-sm"
                >
                    Skip
                </button>
            </div>

            {message && (
                <p className={`text-sm ${status === "success" ? "text-green-600" : "text-red-600"}`}>
                    {message}
                </p>
            )}
        </div>
    );
};

const PersonalitySelectionStep: React.FC<{
    userId: string;
    onNext: () => void;
}> = ({ userId, onNext }) => {
    const supabase = createClient();
    const [personalities, setPersonalities] = useState<any[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchPersonalities = async () => {
            const { data } = await supabase
                .from("personalities")
                .select("personality_id, title, subtitle, short_description")
                .is("creator_id", null)
                .eq("is_doctor", false)
                .limit(12);
            setPersonalities(data || []);
            setLoading(false);
        };
        fetchPersonalities();
    }, []);

    const handleSelect = async () => {
        if (selected) {
            await updateUser(supabase, { personality_id: selected }, userId);
        }
        onNext();
    };

    if (loading) return <Loader2 className="w-4 h-4 animate-spin mt-4" />;

    return (
        <div className="flex flex-col gap-4 mt-4">
            <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                {personalities.map((p) => (
                    <button
                        key={p.personality_id}
                        type="button"
                        onClick={() => setSelected(p.personality_id)}
                        className={`p-3 rounded-md border text-left text-sm ${
                            selected === p.personality_id
                                ? "border-gray-800 bg-gray-50"
                                : "border-gray-200"
                        }`}
                    >
                        <div className="font-medium">{p.title}</div>
                        {p.subtitle && <div className="text-xs text-gray-500">{p.subtitle}</div>}
                    </button>
                ))}
            </div>

            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={handleSelect}
                    className="flex-1 px-4 py-2 bg-gray-800 text-white rounded-md text-sm"
                >
                    {selected ? "Continue" : "Skip"}
                </button>
            </div>
        </div>
    );
};

const Steps: React.FC<{
    selectedUser?: IUser;
    userId: string;
}> = ({ selectedUser, userId }) => {
    const supabase = createClient();
    const router = useRouter();
    const searchParams = useSearchParams();
    const mac = searchParams.get("mac");
    const [progress, setProgress] = React.useState(Math.round(100 / TOTAL_STEPS));
    const [step, setStep] = React.useState(1);

    const advanceStep = () => {
        const nextStep = step + 1;
        if (nextStep > TOTAL_STEPS) {
            router.push("/home");
            return;
        }
        setStep(nextStep);
        setProgress(Math.round((nextStep / TOTAL_STEPS) * 100));
    };

    const headings: Record<number, { heading: string; subHeading: string }> = {
        1: {
            heading: "Hello there!",
            subHeading: "With the following details we will be able to personalize your Elato experience.",
        },
        2: {
            heading: "Connect your device",
            subHeading: "Bind your Elato device to your account. You can also do this later in Settings.",
        },
        3: {
            heading: "Choose a personality",
            subHeading: "Pick a personality for your Elato companion.",
        },
    };

    const { heading, subHeading } = headings[step] || headings[1];

    return (
        <div className="max-w-lg flex-auto flex flex-col gap-2 px-1 font-quicksand ">
            <Progress value={progress} className="bg-amber-200" />
            <p className="text-3xl font-bold mt-5">{heading}</p>
            <p className="text-md text-gray-500 font-medium">{subHeading}</p>
            {step === 1 && (
                <GeneralUserForm
                    selectedUser={selectedUser}
                    userId={userId}
                    onClickCallback={advanceStep}
                    onSave={async (values, userType) => {
                        await updateUser(
                            supabase,
                            {
                                supervisee_age: values.supervisee_age,
                                supervisee_name: values.supervisee_name,
                                supervisee_persona: values.supervisee_persona,
                                user_info: {
                                    user_type: userType,
                                    user_metadata: values,
                                },
                            },
                            userId
                        );
                    }}
                    disabled={false}
                />
            )}
            {step === 2 && (
                <DeviceBindingStep userId={userId} initialMac={mac} onNext={advanceStep} />
            )}
            {step === 3 && (
                <PersonalitySelectionStep userId={userId} onNext={advanceStep} />
            )}
        </div>
    );
};

export default Steps;
