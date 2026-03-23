"use client";

import { connectUserToDevice, connectUserToDeviceByMacAction, unbindDeviceAction, signOutAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { LogOut } from "lucide-react";

import GeneralUserForm from "./UserForm";
import { Slider } from "@/components/ui/slider";
import { updateUser } from "@/db/users";
import _ from "lodash";
import { createClient } from "@/utils/supabase/client";
import React, { useCallback } from "react";
import { doesUserHaveADevice, updateDevice } from "@/db/devices";
import { useToast } from "@/components/ui/use-toast";

interface AppSettingsProps {
    selectedUser: IUser;
    heading: React.ReactNode;
}

const skipDeviceRegistration = process.env.NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION === "True";


const AppSettings: React.FC<AppSettingsProps> = ({
    selectedUser,
    heading,
}) => {
    const supabase = createClient();
    const { toast } = useToast();
    const [isConnected, setIsConnected] = React.useState(false);
    const [deviceInfo, setDeviceInfo] = React.useState<any>(null);
    const doctorFormRef = React.useRef<{ submitForm: () => void } | null>(null);
    const userFormRef = React.useRef<{ submitForm: () => void } | null>(null);
    const [bindingMode, setBindingMode] = React.useState<"code" | "mac">("code");
    const [deviceCode, setDeviceCode] = React.useState("");
    const [error, setError] = React.useState("");

    const handleSave = () => {
        if (selectedUser.user_info.user_type === "doctor") {
            doctorFormRef.current?.submitForm();
        } else {
            userFormRef.current?.submitForm();
        }
    };

    const fetchDeviceInfo = useCallback(async () => {
        const { data } = await supabase
            .from("devices")
            .select("*")
            .eq("user_id", selectedUser.user_id)
            .maybeSingle();
        if (data) {
            setIsConnected(true);
            setDeviceInfo(data);
        } else {
            setIsConnected(false);
            setDeviceInfo(null);
        }
    }, [selectedUser.user_id, supabase]);

    React.useEffect(() => {
        fetchDeviceInfo();
    }, [fetchDeviceInfo]);


    const [volume, setVolume] = React.useState([
        selectedUser.device?.volume ?? 50,
    ]);

    const debouncedUpdateVolume = _.debounce(async () => {
        if (selectedUser.device?.device_id) {
            await updateDevice(
                supabase,
                { volume: volume[0] },
                selectedUser.device.device_id
            );
        }
    }, 1000); // Adjust the debounce delay as needed

    const updateVolume = (value: number[]) => {
        setVolume(value);
        debouncedUpdateVolume();
    };

    const onSave = async (values: any, userType: "doctor" | "user", userId: string) => {

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
            userId);
            toast({
                description: "Your prefereces have been saved!",
            });
    }

    const handleRegister = async () => {
        setError("");
        let result = false;
        if (bindingMode === "mac") {
            result = await connectUserToDeviceByMacAction(selectedUser.user_id, deviceCode.trim());
        } else {
            result = await connectUserToDevice(selectedUser.user_id, deviceCode.trim());
        }
        if (!result) {
            setError(bindingMode === "mac" ? "Device not found or already bound." : "Invalid device code.");
        }
        fetchDeviceInfo();
    };

    const handleUnbind = async () => {
        if (!deviceInfo?.device_id) return;
        try {
            await unbindDeviceAction(deviceInfo.device_id, selectedUser.user_id);
            toast({ description: "Device unbound successfully." });
            setDeviceCode("");
            fetchDeviceInfo();
        } catch {
            toast({ description: "Failed to unbind device.", variant: "destructive" });
        }
    };

    return (
        <>
            <GeneralUserForm
                    selectedUser={selectedUser}
                    userId={selectedUser.user_id}
                    heading={heading}
                    onSave={onSave}
                    onClickCallback={() => handleSave()}
                />

            <div className="space-y-4 max-w-screen-sm mt-12">
                <h2 className="text-lg font-semibold border-b border-gray-200 pb-2">
                    Device settings
                </h2>
                {skipDeviceRegistration && <div className="flex flex-col text-purple-500 text-xs gap-2">You don't need to register your device because NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION is set to True.</div>}
                <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                    <div className="flex flex-row items-center gap-2">
                    <Label className="text-sm font-medium text-gray-700">
                    Register your device
                    </Label>
                        <div
                            className={`rounded-full flex-shrink-0 h-2 w-2 ${
                                isConnected ? 'bg-green-500' : 'bg-amber-500'
                            }`}
                        />

                        </div>

                        {isConnected && deviceInfo && (
                            <div className="flex flex-col gap-1 text-xs text-gray-500 mb-2">
                                <span>MAC: {deviceInfo.mac_address}</span>
                                {deviceInfo.device_name && <span>Name: {deviceInfo.device_name}</span>}
                                {deviceInfo.firmware_version && <span>Firmware: {deviceInfo.firmware_version}</span>}
                                <span>Code: {deviceInfo.user_code}</span>
                            </div>
                        )}

                        {!isConnected && !skipDeviceRegistration && (
                            <div className="flex gap-2 mb-1">
                                <button
                                    type="button"
                                    onClick={() => { setBindingMode("code"); setDeviceCode(""); setError(""); }}
                                    className={`px-2 py-0.5 rounded text-xs ${bindingMode === "code" ? "bg-gray-800 text-white" : "bg-gray-100"}`}
                                >
                                    Device Code
                                </button>
                                <button
                                    type="button"
                                    onClick={() => { setBindingMode("mac"); setDeviceCode(""); setError(""); }}
                                    className={`px-2 py-0.5 rounded text-xs ${bindingMode === "mac" ? "bg-gray-800 text-white" : "bg-gray-100"}`}
                                >
                                    MAC Address
                                </button>
                            </div>
                        )}

                        <div className="flex flex-row items-center gap-2 mt-2">
                            <Input
                                value={deviceCode}
                                disabled={isConnected || skipDeviceRegistration}
                                onChange={(e) => setDeviceCode(e.target.value)}
                                placeholder={
                                    isConnected ? "**********" :
                                    bindingMode === "mac" ? "XX:XX:XX:XX:XX:XX" : "Enter your device code"
                                }
                                maxLength={100}
                            />
                            {isConnected ? (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={handleUnbind}
                                >
                                    Unbind
                                </Button>
                            ) : (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={skipDeviceRegistration}
                                    onClick={handleRegister}
                                >
                                    Register
                                </Button>
                            )}
                        </div>
                        <p className="text-xs text-gray-400">
                            {isConnected ? <span className="font-medium text-gray-800">Registered!</span> :
                                error ? <span className="text-red-500">{error}</span> :
                                bindingMode === "mac" ? "Enter your device MAC address to register it." : "Enter your device code to register it."
                        }
                        </p>
                </div>
                    <div className="flex flex-col gap-2 mt-2">
                        <Label className="text-sm font-medium text-gray-700">
                            Logged in as
                        </Label>
                        <Input
                            // autoFocus
                            disabled
                            value={selectedUser?.email}
                            className="max-w-screen-sm h-10 bg-white"
                            autoComplete="on"
                            style={{
                                fontSize: 16,
                            }}
                        />
                    </div>
                    {isConnected && <div className="flex flex-col gap-4 mt-6">
                        <Label className="text-sm font-medium text-gray-700">
                            Device volume
                        </Label>
                        <div className="flex flex-row gap-2 items-center flex-nowrap">
                            <Slider
                                value={volume}
                                onValueChange={updateVolume}
                                className="sm:w-1/2"
                                defaultValue={[50]}
                                max={100}
                                min={1}
                                step={1}
                            />
                            <p className="text-gray-500 text-sm">{volume}%</p>
                        </div>
                    </div>}
            <form
                            action={signOutAction}
                        className="flex flex-row justify-between mt-4"
                    >
                        <Button
                            variant="destructive_outline"
                            size="sm"
                            className="font-medium flex flex-row items-center rounded-full gap-2 "
                        >
                            <LogOut size={18} strokeWidth={2} />
                            <span>Logout</span>
                            </Button>
                        </form>
                </div>
            </div>
        </>
    );
};

export default AppSettings;
