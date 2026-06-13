import React, { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { App } from "./ui/App";
import { AppLogo } from "./ui/AppLogo";
import "./styles.css";

const ConverterPage = React.lazy(() =>
  import("./ui/ConverterPage").then((module) => ({ default: module.ConverterPage }))
);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Suspense fallback={<div className="min-h-screen bg-[#080b10] flex flex-col items-center justify-center text-slate-100 font-sans gap-4"><AppLogo size={64} className="rounded-2xl shadow-xl shadow-cyan-500/10 animate-pulse" /><div className="font-semibold text-sm tracking-wider text-slate-300">Loading Workspace...</div></div>}>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/converter" element={<ConverterPage />} />
          <Route path="*" element={<App />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>
);
