import { GpxUpload } from "@/components/GpxUpload";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-1 flex-col items-center gap-6 px-4 py-10 sm:gap-8 sm:px-6 sm:py-24">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            RouteRider
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Route hochladen, um den Reifendruck zu berechnen.
          </p>
        </div>
        <GpxUpload />
      </main>
    </div>
  );
}
