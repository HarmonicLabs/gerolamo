import { ReactNode } from "react";
import { AppSidebar } from "@/components/AppSidebar";

export function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen w-full">
      <AppSidebar />
      <main className="flex-1 min-w-0 overflow-auto">
        <div className="p-4 lg:p-6 max-w-[1800px] mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
