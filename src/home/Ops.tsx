import type { ViewName } from "../data";
import { Button, Card, Section } from "../ui";

/*
 * Ops (ADR-004) is the Command Center, and it is M33.3. Until it lands the switch still has
 * somewhere to go: this page says what is coming and where the same facts are today.
 */
export default function Ops({ onNavigate }: { onNavigate: (view: ViewName) => void }) {
  return (
    <div className="ops-preview" data-density="compact">
      <header className="home-hello">
        <div>
          <h1>Ops</h1>
          <p className="home-verdict"><span>The dense view of the same facts as Home: load, what needs you by risk tier, containers, jobs and backups.</span></p>
        </div>
      </header>
      <Card>
        <Section level={2} title="Arriving with M33.3" summary="Until then, the Classic overview and Performance show these facts.">
          <div className="ops-preview__links">
            <Button onClick={() => onNavigate("overview")}>Classic overview</Button>
            <Button onClick={() => onNavigate("performance")}>Performance</Button>
            <Button onClick={() => onNavigate("home")}>Back to Home</Button>
          </div>
        </Section>
      </Card>
    </div>
  );
}
