"use client";

import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle, XCircle, Smartphone } from "lucide-react";

export default function DeviceBindPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const mac = searchParams.get("mac");

  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");

  useEffect(() => {
    if (!mac) {
      setStatus("error");
      setErrorMessage("No MAC address provided");
    }
  }, [mac]);

  const handleBind = async () => {
    if (!mac) return;

    setStatus("loading");
    setErrorMessage("");

    try {
      const response = await fetch("/api/devices/bind", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ macAddress: mac }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          // Not logged in, redirect to register with mac
          router.push(`/register?mac=${encodeURIComponent(mac)}`);
          return;
        }
        throw new Error(data.error || "Failed to bind device");
      }

      setStatus("success");

      // Redirect to dashboard after 2 seconds
      setTimeout(() => {
        router.push("/");
      }, 2000);

    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Unknown error");
    }
  };

  return (
    <div className="flex-1 flex flex-col w-full px-8 sm:max-w-md justify-center gap-2 mx-auto py-12">
      <Card className="bg-white shadow-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <Smartphone size={48} className="text-blue-500" />
          </div>
          <CardTitle>Bind Device / 绑定设备</CardTitle>
          <CardDescription>
            Connect your Elato device to your account
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {mac && (
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <p className="text-sm text-gray-500 mb-2">Device MAC Address</p>
              <p className="font-mono text-lg font-semibold text-gray-800">{mac}</p>
            </div>
          )}

          {status === "idle" && mac && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 text-center">
                Click the button below to bind this device to your account.
                <br />
                点击下方按钮将此设备绑定到您的账户。
              </p>
              <Button
                onClick={handleBind}
                className="w-full bg-blue-500 hover:bg-blue-600"
                size="lg"
              >
                Bind Device / 绑定设备
              </Button>
            </div>
          )}

          {status === "loading" && (
            <div className="flex flex-col items-center gap-4 py-4">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
              <p className="text-gray-600">Binding device... / 绑定中...</p>
            </div>
          )}

          {status === "success" && (
            <div className="flex flex-col items-center gap-4 py-4">
              <CheckCircle className="h-12 w-12 text-green-500" />
              <div className="text-center">
                <p className="text-lg font-semibold text-green-600">
                  Device Bound Successfully!
                </p>
                <p className="text-green-600">设备绑定成功！</p>
                <p className="text-sm text-gray-500 mt-2">
                  Redirecting to dashboard...
                </p>
              </div>
            </div>
          )}

          {status === "error" && (
            <div className="flex flex-col items-center gap-4 py-4">
              <XCircle className="h-12 w-12 text-red-500" />
              <div className="text-center">
                <p className="text-lg font-semibold text-red-600">
                  Binding Failed / 绑定失败
                </p>
                <p className="text-sm text-gray-600 mt-2">{errorMessage}</p>
              </div>
              {mac && (
                <Button
                  onClick={handleBind}
                  variant="outline"
                  className="mt-4"
                >
                  Try Again / 重试
                </Button>
              )}
            </div>
          )}

          {!mac && status === "error" && (
            <div className="text-center">
              <p className="text-sm text-gray-500">
                Please access this page from your device's WiFi configuration page.
                <br />
                请从设备的 WiFi 配置页面访问此页面。
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
