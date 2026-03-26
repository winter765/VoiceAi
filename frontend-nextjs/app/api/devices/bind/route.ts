import { createClient } from "@/utils/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { addUserToDeviceByMac, getDeviceByMac, createDevice } from "@/db/devices";

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient();

    // Check if user is authenticated
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Get MAC address from request body
    const body = await request.json();
    const { macAddress } = body;

    if (!macAddress) {
      return NextResponse.json(
        { error: "macAddress is required" },
        { status: 400 }
      );
    }

    // Check if device exists
    let device = await getDeviceByMac(supabase, macAddress);

    // If device doesn't exist, create it
    if (!device) {
      device = await createDevice(supabase, macAddress);
      if (!device) {
        return NextResponse.json(
          { error: "Failed to create device" },
          { status: 500 }
        );
      }
    }

    // Check if device is already bound to another user
    if (device.user_id && device.user_id !== user.id) {
      return NextResponse.json(
        { error: "Device is already bound to another user" },
        { status: 409 }
      );
    }

    // Bind device to user
    const result = await addUserToDeviceByMac(supabase, macAddress, user.id);

    if (!result) {
      return NextResponse.json(
        { error: "Failed to bind device" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Device bound successfully",
      device: {
        mac_address: macAddress,
        user_id: user.id,
      }
    });

  } catch (error) {
    console.error("Error binding device:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
