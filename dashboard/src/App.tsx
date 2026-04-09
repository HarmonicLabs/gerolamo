import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DashboardLayout } from "@/components/DashboardLayout";
import OverviewPage from "./pages/OverviewPage";
import NodePage from "./pages/NodePage";
import BlocksPage from "./pages/BlocksPage";
import PeersPage from "./pages/PeersPage";
import MempoolPage from "./pages/MempoolPage";
import ExplorerPage from "./pages/ExplorerPage";
import WalletPage from "./pages/WalletPage";
import ChainDiagramPage from "./pages/ChainDiagramPage";
import LogsPage from "./pages/LogsPage";
import SettingsPage from "./pages/SettingsPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Sonner
        theme="dark"
        toastOptions={{
          style: {
            background: "hsl(240 15% 7%)",
            border: "1px solid hsl(240 10% 15%)",
            color: "hsl(210 20% 90%)",
          },
        }}
      />
      <BrowserRouter>
        <DashboardLayout>
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/node" element={<NodePage />} />
            <Route path="/blocks" element={<BlocksPage />} />
            <Route path="/peers" element={<PeersPage />} />
            <Route path="/mempool" element={<MempoolPage />} />
            <Route path="/explorer" element={<ExplorerPage />} />
            <Route path="/wallet" element={<WalletPage />} />
            <Route path="/chain" element={<ChainDiagramPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </DashboardLayout>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
