# Spiral: submission write-up

*Paste-ready text for the submission form. Every number here is in the README or comes from a recorded run.*

## Track
Track 1: Frontier Agents with Gemini. Autonomous agents, multi-step reasoning and verification loops, built with Gemini 4 Argon.

## Links
- Repo: https://github.com/Hha21/halloween-hack
- Live demo (no install): https://hha21.github.io/halloween-hack/
- Video: https://youtu.be/MRcF7TbEF20

## Tagline
Describe an aircraft in plain English. Spiral sizes it, closes the design spiral, and shows where every number came from.

## Inspiration
Aircraft design is a spiral. The mission sets the weight, the weight sizes the wing and the structure, the structure changes the weight, and round it goes. In industry each lap takes days to weeks across tools and teams. We wanted an agent that runs the spiral by itself, the way a design team would, and that never asks you to trust a number it can't trace back to a source.

## What it does
- **Chat to start.** Type "Four-seat tourer, London to New York non-stop, 5,570 km range, cruise 115 kt…". Gemini reads it and quotes your exact words for every value it took. Python converts the units, range-checks them, and fills every unstated parameter with a default cited to Raymer, *Aircraft Design: A Conceptual Approach* (2nd ed.).
- **The design spiral.** Each lap runs weight closure, Breguet fuel fractions and wing sizing (Raymer Ch. 3 and 5), then Schrenk spar loads and I-beam spar sizing at ultimate load, with compression-yield caps and a web that must not buckle (Ch. 14). The sized spar mass goes back into the weight until MTOW converges. The default four-seater lands within about 10% of a real Cessna 172S.
- **When physics says no, Gemini decides.** London to New York climbs lap by lap to 3,467 kg, over the 2,722 kg single-engine class limit. Python computes every single change that would close the design by re-running the spiral. Gemini, as design lead, picks the one that fits what you asked for: it keeps the route and flies with 1 passenger (closes at 2,422 kg) rather than cutting the range. For a "family tourer" it makes the opposite call, keeping the seats. One click accepts the proposal and the spiral re-runs.
- **Detailed design.** The main wing spar goes to CAD (STEP and STL) and a beam FEA, compared with beam theory.
- **Every number has a source.** About 100 numbers per run carry a provenance badge: your words, Gemini-inferred, a cited default, an equation, a table, or a simulation. Each also carries a verified flag. The report ends with the textbook items behind the numbers.
- **Ask the textbook.** Questions such as "What tail volume coefficients suit a GA single?" get answers grounded only in critic-checked book items, with clickable citations.

## How we built it
- **Agents.** Intake agent: Gemini 3.5 Flash. Design lead, research agent (Ask Raymer) and report writer: **Gemini 4 Argon**. Textbook critic: Gemini 3.1 Pro.
- **Gemini decides, Python computes.** The agents read, choose and write, but never supply a number. Python computes everything. Every Gemini text that contains numbers passes a validator against the design state, with one retry and a deterministic fallback.
- **Knowledge pipeline.** Gemini read all 391 scanned PDF pages of Raymer as page images and extracted 692 equations, 118 tables and 886 rules of thumb. An independent critic model (`gemini-3.1-pro-preview`) checked every item against the same page: 596 equations confirmed, 96 disputed. A design constant is marked verified only when the critic confirmed that exact table or equation and every number in our table row appears in it.
- **Stack.** Python, FastAPI and server-sent events stream the spiral lap by lap. Plain ES-module front end with Three.js (a particle "design spiral" that assembles the aircraft, the 3D workspace, and a stress-coloured spar). CadQuery for CAD.
- **Runs without a key.** A static demo mode replays real recorded Gemini runs, so the front end works with no backend and no API key.
- **Team.** Two people, two agent logs (`HARRY_AGENT_LOG.md`, `THARM_AGENT_LOG.md`), and a typed contract (`spiral/contract.py`) between the agent side and the CAD/FEA and front-end side.

## Challenges
- Keeping an LLM from inventing numbers. The answer was structural: Gemini quotes, chooses and explains, while Python converts, computes and validates.
- Citations that are real. We extracted the whole book, had a second model critique the extraction, and only then marked our constants verified.
- The design-closure maths: the textbook statistics happily "close" a 3.4-tonne four-seater, so we added a class limit and computed relaxations.

## Accomplishments
- An agent whose engineering decision changes with your intent, using numbers it didn't make up.
- 596 critic-confirmed textbook equations behind a live design loop.
- An end-to-end demo: chat → spiral → infeasible → Gemini's fix → convergence → CAD/FEA → cited report.

## What's next
More components (tail, landing gear, fuselage frames), higher-fidelity aerodynamics, more relaxation levers (cruise speed, reserve, materials), and export to real CAD and analysis tools.

## Built with
Gemini 4 Argon · Gemini 3.5 Flash · Gemini 3.1 Pro (critic) · Python · FastAPI · NumPy · CadQuery · Three.js · Remotion
