"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { buttonVariants, Button } from "@/components/ui/button";
import { Dot, LogOut, User } from "lucide-react";
import { createClient } from "@/utils/supabase/client";

interface SidebarNavProps extends React.HTMLAttributes<HTMLElement> {
    items: SidebarNavItem[];
    user?: IUser;
}

export function SidebarNav({ className, items, user, ...props }: SidebarNavProps) {
    const pathname = usePathname();
    const router = useRouter();
    const supabase = createClient();

    const handleSignOut = async () => {
        await supabase.auth.signOut();
        router.push("/login");
    };

    const primaryItem = (item: SidebarNavItem) => {
        return <Link
        key={item.href}
        href={item.href}
        className={cn(
            buttonVariants({ variant: "primary" }),
            pathname === item.href ? "bg-muted shadow-xl" : "",
            "w-fit justify-start rounded-full text-sm sm:text-xl text-normal text-white bg-yellow-500 hover:bg-yellow-400"
        )}
    >
        <span className="mr-2">{item.icon}</span>
        {item.title}
    </Link>
    }

    return (
        <nav
            className={cn(
                "max-w-[220px] mx-auto hidden md:flex space-x-2 justify-between px-4 sm:justify-evenly md:justify-start md:flex-col md:space-x-0 md:space-y-6 rounded-xl",
                className
            )}
            {...props}
        >
            {items.map((item) => {
                if (item.isPrimary) {
                    return primaryItem(item);
                }
                return (
                    <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                            buttonVariants({ variant: "ghost" }),
                            pathname === item.href ? "bg-muted" : "",
                            "justify-start rounded-full text-sm sm:text-xl text-normal text-stone-700"
                        )}
                    >
                        <span className="mr-2">{item.icon}</span>
                        {item.title}
                        {pathname === item.href && (
                            <Dot className="hidden sm:block flex-shrink-0" size={48} />
                        )}
                    </Link>
                );
            })}

            {/* User Info Section */}
            {user && (
                <div className="mt-auto pt-6 border-t border-gray-200">
                    <div className="flex items-center gap-3 px-3 py-2">
                        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-yellow-100 text-yellow-600">
                            <User size={20} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">
                                {user.supervisor_name || user.email?.split("@")[0] || "User"}
                            </p>
                            <p className="text-xs text-gray-500 truncate">
                                {user.email}
                            </p>
                        </div>
                    </div>
                    <Button
                        variant="ghost"
                        className="w-full justify-start mt-2 text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-full"
                        onClick={handleSignOut}
                    >
                        <LogOut size={18} className="mr-2" />
                        Sign out
                    </Button>
                </div>
            )}
        </nav>
    );
}
