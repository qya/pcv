import React, { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { App } from "./ui/App";
import "./styles.css";

const ConverterPage = React.lazy(() =>
  import("./ui/ConverterPage").then((module) => ({ default: module.ConverterPage }))
);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Suspense fallback={<div className="min-h-screen bg-[#080b10] flex flex-col items-center justify-center text-slate-100 font-sans"><div className="w-10 h-10 rounded-full border-4 border-cyan-500/20 border-t-cyan-400 animate-spin mb-4"></div><div className="font-semibold text-sm tracking-wider text-slate-300">Loading Workspace...</div></div>}>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/converter" element={<ConverterPage />} />
          <Route path="*" element={<App />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>
);
