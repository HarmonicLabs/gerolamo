import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="text-center space-y-4">
        <h1 className="text-6xl font-bold neon-text-red">404</h1>
        <p className="text-lg text-muted-foreground">Route not found</p>
        <Link to="/" className="text-secondary underline hover:text-secondary/80">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
