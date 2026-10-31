"""Frozen contract between Harry (intake, agents, sizing, server) and Tharm (geometry, CAD, FEA, frontend).

Two boundaries (DESIGN_SPEC.md section 8):

1. Agent-to-CAD/FEA (Python). Harry's sizing tools output ConceptualSizingResult,
   SparLoadsResult and SparSizingResult; the orchestrator passes them to Tharm's
   aircraft_geometry(), build_spar_cad() and run_fea() in spiral/tools/.
2. HTTP / SSE (JSON). Every request, response and event payload between server/app.py and
   web/api_client.js is the `.to_dict()` of a dataclass in this module (section 7 below).

Example payloads for both boundaries live in `fixtures/`, so each side can build against them
without the other running. Regenerate with `python3 scripts/generate_fixtures.py` after any
change here; `tests/test_contract.py` checks the fixtures still parse.

Conventions:
- SI units everywhere (kg, m, s, N, W, Pa, J). Numeric field names carry a unit suffix.
- Tools are pure, deterministic functions returning ToolResult[T] or raising ToolError.
- Never return NaN or silently clamp; out-of-range inputs compute and append to warnings.
- Change this file only when both people agree, then regenerate the fixtures.
"""

from __future__ import annotations

import json
import types
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from datetime import datetime, timezone
from typing import Any, Generic, TypeVar, Union, get_args, get_origin, get_type_hints

T = TypeVar("T")

ARTIFACTS_URL_PREFIX = "/artifacts"


# ---------------------------------------------------------------------------
# 0. Serialisation helpers
# ---------------------------------------------------------------------------


def _build(tp: Any, data: Any) -> Any:
    """Rebuild a value of type `tp` from its JSON form (inverse of dataclasses.asdict)."""
    if data is None:
        return None
    origin = get_origin(tp)
    if origin in (Union, types.UnionType):
        args = [a for a in get_args(tp) if a is not type(None)]
        return _build(args[0], data) if len(args) == 1 else data
    if origin is list:
        (item_tp,) = get_args(tp)
        return [_build(item_tp, x) for x in data]
    if origin is dict:
        _, value_tp = get_args(tp)
        return {k: _build(value_tp, v) for k, v in data.items()}
    if is_dataclass(tp):
        if isinstance(data, tp):
            return data
        hints = get_type_hints(tp)
        names = {f.name for f in fields(tp) if f.init}
        # Unknown keys are ignored so older/newer payloads still load.
        return tp(**{k: _build(hints[k], v) for k, v in data.items() if k in names})
    if tp is float and isinstance(data, int):
        return float(data)
    return data


class _Serialisable:
    def to_dict(self) -> dict[str, Any]:
        return asdict(self)  # type: ignore[call-overload]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Any:
        return _build(cls, data)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# 1. Tool envelope & provenance
# ---------------------------------------------------------------------------


class ToolError(Exception):
    """Raised by a deterministic tool when physics/math fails to close."""

    def __init__(
        self,
        message: str,
        *,
        tool_name: str = "unknown_tool",
        recoverable: bool = True,
        suggested_field: str | None = None,
    ) -> None:
        super().__init__(message)
        self.tool_name = tool_name
        self.message = message
        self.recoverable = recoverable
        self.suggested_field = suggested_field

    def to_dict(self) -> dict[str, Any]:
        return {
            "tool_name": self.tool_name,
            "message": self.message,
            "recoverable": self.recoverable,
            "suggested_field": self.suggested_field,
        }


@dataclass
class Provenance(_Serialisable):
    """Where one displayed number comes from. Drives the source badge in the UI."""

    kind: str  # "equation" | "table" | "simulation" | "assumption" | "user_input" | "gemini_default"
    source: str  # e.g. "Raymer 2ed, Eq. 3.4 (p. 12)", "knowledge/tables/materials.yaml#al_2024_t3"
    verified: bool = True  # False -> amber badge: citation not yet checked against the page
    warning: str | None = None  # set -> amber badge: e.g. heuristic used outside its valid range


@dataclass
class ToolResult(Generic[T]):
    """Standard envelope returned by every deterministic tool."""

    value: T
    sources: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # Keyed by field name of `value` ("mtow_kg"); the orchestrator prefixes it into
    # DesignState.provenance ("latest_sizing.mtow_kg").
    provenance: dict[str, Provenance] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# 2. Mission Specification (intake output, confirmed in the UI)
# ---------------------------------------------------------------------------


@dataclass
class MissionSpec(_Serialisable):
    """Structured aircraft design specification (all SI units)."""

    # Payload
    crew_count: int = 1
    passenger_count: int = 3
    person_mass_kg: float = 86.0
    baggage_mass_kg: float = 50.0

    # Mission
    range_m: float = 1_000_000.0  # 1,000 km
    cruise_speed_ms: float = 60.0  # ~117 kt
    cruise_altitude_m: float = 2_500.0
    stall_speed_ms: float = 28.0  # ~54 kt
    reserve_s: float = 2_700.0  # 45 min loiter reserve

    # Wing & Aerodynamics
    aspect_ratio: float = 7.6  # Raymer 2ed Table 4.1, GA single engine
    taper_ratio: float = 0.45  # Raymer 2ed p. 56: near-elliptical lift, unswept wing
    thickness_to_chord: float = 0.15
    cl_max: float = 1.6
    ld_max: float = 11.0

    # Propulsion
    prop_efficiency: float = 0.80
    bsfc_kg_per_j: float = 6.8e-8

    # Structure
    limit_load_factor: float = 3.8
    ultimate_factor: float = 1.5
    spar_material: str = "al_2024_t3"

    # Layout
    wing_position: str = "high"  # "high" | "mid" | "low"

    # Meta
    name: str = "GA-4 Touring"
    raw_description: str = ""
    defaulted_fields: dict[str, str] = field(default_factory=dict)  # field_name -> reason
    stated_fields: dict[str, str] = field(default_factory=dict)  # field_name -> the user's exact words (intake)

    @property
    def n_ult(self) -> float:
        return self.limit_load_factor * self.ultimate_factor

    @property
    def payload_mass_kg(self) -> float:
        return (self.crew_count + self.passenger_count) * self.person_mass_kg + self.baggage_mass_kg


# ---------------------------------------------------------------------------
# 3. Agent outputs (Harry: spiral.tools.sizing, spiral.tools.spar)
# ---------------------------------------------------------------------------


@dataclass
class ConceptualSizingResult(_Serialisable):
    """Output of conceptual_sizing()."""

    mtow_kg: float
    empty_mass_kg: float
    fuel_mass_kg: float
    payload_mass_kg: float
    empty_fraction: float
    fuel_fraction: float
    spar_mass_used_kg: float
    statistical_spar_mass_kg: float
    wing_loading_pa: float
    wing_area_m2: float
    span_m: float
    root_chord_m: float
    tip_chord_m: float
    mac_m: float
    cruise_power_w: float
    installed_power_w: float
    # "warmup_takeoff", "climb", "cruise", "loiter", "landing"
    segment_fractions: dict[str, float] = field(default_factory=dict)
    # "wing_spar", "remaining_empty", "fuel", "crew", "passengers", "baggage"
    mass_breakdown_kg: dict[str, float] = field(default_factory=dict)


@dataclass
class SparStationLoad(_Serialisable):
    """Spanwise load station from y=0 (root) to y=b/2 (tip), at ultimate load."""

    y_m: float
    chord_m: float
    elliptical_lift_n_per_m: float
    planform_lift_n_per_m: float
    schrenk_lift_n_per_m: float
    shear_n: float
    moment_nm: float


@dataclass
class SparLoadsResult(_Serialisable):
    """Output of spar_loads()."""

    n_ult: float
    semi_span_m: float
    root_shear_n: float
    root_moment_nm: float
    stations: list[SparStationLoad] = field(default_factory=list)


@dataclass
class SparStationSection(_Serialisable):
    """Spanwise I-beam section and beam-theory stresses from y=0 (root) to y=b/2 (tip)."""

    y_m: float
    depth_m: float  # outer depth, outside of top cap to outside of bottom cap
    cap_area_m2: float
    cap_width_m: float
    cap_thickness_m: float
    web_thickness_m: float
    bending_stress_pa: float
    shear_stress_pa: float
    deflection_m: float


@dataclass
class SparSizingResult(_Serialisable):
    """Output of size_spar()."""

    material_key: str
    mass_both_wings_kg: float
    semi_span_mass_kg: float
    root_depth_m: float
    tip_depth_m: float
    root_cap_area_m2: float
    root_cap_width_m: float
    root_cap_thickness_m: float
    root_web_thickness_m: float
    max_bending_stress_pa: float
    max_shear_stress_pa: float
    allowable_yield_stress_pa: float
    safety_margin: float  # allowable / max - 1
    tip_deflection_m: float
    stations: list[SparStationSection] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 4. Detailed CAD & FEA (Tharm: spiral.tools.cad, spiral.tools.fea)
# ---------------------------------------------------------------------------


@dataclass
class SparCadResult(_Serialisable):
    """Output of build_spar_cad(). Paths are filesystem paths; the frontend uses
    ComponentStatus.artifact_urls instead."""

    step_path: str
    stl_path: str
    volume_single_wing_m3: float
    cad_mass_both_wings_kg: float
    bounding_box_m: dict[str, float] = field(default_factory=dict)  # x_width_m, y_semi_span_m, z_depth_m


@dataclass
class FeaStationResult(_Serialisable):
    """Spanwise comparison between 3D FEA and Euler-Bernoulli beam theory."""

    y_m: float
    fea_von_mises_pa: float
    beam_stress_pa: float
    fea_deflection_m: float
    beam_deflection_m: float


@dataclass
class FeaResult(_Serialisable):
    """Output of run_fea()."""

    solver_name: str
    fea_max_von_mises_pa: float
    fea_tip_deflection_m: float
    beam_max_stress_pa: float
    beam_tip_deflection_m: float
    stress_agreement_pct: float
    deflection_agreement_pct: float
    safety_margin_fea: float
    stress_mesh_path: str | None = None
    stations: list[FeaStationResult] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 4b. Secondary structural components (spiral.tools.tail, spiral.tools.landing_gear)
# ---------------------------------------------------------------------------


@dataclass
class HorizontalTailResult(_Serialisable):
    """Output of horizontal_tail_spar(): Raymer's tail load case, then the shared I-beam sizing."""

    stall_speed_ms: float
    level_speed_ms: float  # V_L in Eq. 14.12 (cruise speed from the spec)
    kp: float
    maneuver_speed_ms: float
    air_density_kg_m3: float
    dynamic_pressure_pa: float
    normal_force_coefficient: float  # C_n, the governing (downward) value
    tail_area_m2: float
    tail_span_m: float
    root_chord_m: float
    tip_chord_m: float
    thickness_to_chord: float
    limit_tail_load_n: float
    ultimate_tail_load_n: float
    loads: SparLoadsResult
    spar: SparSizingResult


@dataclass
class LandingGearResult(_Serialisable):
    """Output of size_main_landing_gear(): oleo-pneumatic main gear strut (Raymer 2ed, Ch. 11)."""

    landing_mass_kg: float
    sink_speed_ms: float
    gear_load_factor: float
    shock_efficiency: float
    main_gear_load_share: float
    main_strut_count: int
    static_load_per_strut_n: float
    landing_load_per_strut_n: float
    vertical_kinetic_energy_j: float
    stroke_required_m: float  # Eq. 11.12, tire deflection neglected
    stroke_m: float  # with margin and minimum applied
    oleo_length_m: float
    oleo_diameter_m: float
    oleo_internal_pressure_pa: float


# ---------------------------------------------------------------------------
# 5. 3D Aircraft Geometry (Tharm: spiral.tools.geometry)
# ---------------------------------------------------------------------------


@dataclass
class AircraftGeometry(_Serialisable):
    """Parametric Three.js primitives (all dimensions in metres)."""

    fuselage: dict[str, float] = field(default_factory=dict)
    wing: dict[str, float | str] = field(default_factory=dict)
    horizontal_tail: dict[str, float] = field(default_factory=dict)
    vertical_tail: dict[str, float] = field(default_factory=dict)
    propeller: dict[str, float] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# 6. DesignState (Harry's orchestrator produces; Tharm's frontend renders)
# ---------------------------------------------------------------------------


@dataclass
class LapRecord(_Serialisable):
    """Summary of a single lap around the design spiral (one point on the convergence plot)."""

    lap: int
    mtow_kg: float
    empty_mass_kg: float
    fuel_mass_kg: float
    spar_mass_kg: float
    mtow_change_pct: float
    wing_area_m2: float
    span_m: float
    max_bending_stress_pa: float
    tip_deflection_m: float
    geometry: AircraftGeometry


@dataclass
class AgentLogEntry(_Serialisable):
    """Traceable agent decision or calculation log item."""

    lap: int
    stage: str  # "intake" | "conceptual" | "preliminary" | "convergence" | "detailed" | "report"
    message: str
    citations: list[str] = field(default_factory=list)
    level: str = "info"  # "info" | "warning" | "error"
    timestamp: str = field(default_factory=_now_iso)  # ISO 8601, UTC


@dataclass
class SpecRelaxationProposal(_Serialisable):
    """Gemini's single proposed parameter relaxation when the spiral is infeasible."""

    field_name: str  # a MissionSpec field
    old_value: float
    new_value: float
    unit: str
    reasoning: str
    estimated_mtow_kg: float | None = None


@dataclass
class ComponentStatus(_Serialisable):
    """Detailed design status for a structural component."""

    component_id: str
    name: str
    available: bool  # False -> "coming soon"; `unavailable_reason` says why
    status: str = "pending"  # "pending" | "running_loads" | "running_cad" | "running_fea" | "completed" | "coming_soon"
    cad: SparCadResult | None = None
    fea: FeaResult | None = None
    horizontal_tail: HorizontalTailResult | None = None  # component "horizontal_tail"
    landing_gear: LandingGearResult | None = None  # component "main_landing_gear"
    unavailable_reason: str | None = None
    # What the frontend downloads/fetches: "step", "stl", "stress_mesh" -> "/artifacts/<file>"
    artifact_urls: dict[str, str] = field(default_factory=dict)


def default_components() -> dict[str, ComponentStatus]:
    return {
        "main_wing_spar": ComponentStatus(
            component_id="main_wing_spar",
            name="Main Wing Spar (I-Section, Al 2024-T3)",
            available=True,
            status="pending",
        ),
        "main_landing_gear": ComponentStatus(
            component_id="main_landing_gear",
            name="Main Landing Gear Oleo Strut",
            available=True,
            status="pending",
        ),
        "horizontal_tail": ComponentStatus(
            component_id="horizontal_tail",
            name="Horizontal Tail Spar (I-Section)",
            available=True,
            status="pending",
        ),
        "engine_mount": ComponentStatus(
            component_id="engine_mount",
            name="Engine Mount Truss",
            available=True,  # [Tharm, per THARM log T3] solved in the main spar run (fea.py components_fea)
            status="pending",
        ),
        "fuselage_frames": ComponentStatus(
            component_id="fuselage_frames",
            name="Wing Carry-Through Fuselage Frames",
            available=True,  # [Tharm, per THARM log T3] solved in the main spar run (fea.py components_fea)
            status="pending",
        ),
    }


@dataclass
class DesignState(_Serialisable):
    """Complete state of a design session. The frontend renders this and posts it back.

    `provenance` keys are dotted paths into this object's JSON:
        "spec.range_m", "latest_sizing.mtow_kg", "latest_spar.safety_margin",
        "components.main_wing_spar.fea.fea_max_von_mises_pa"
    List items use "[]": "latest_spar.stations[].bending_stress_pa". Values in `history[]`
    reuse the matching `latest_*` key. A displayed number with no entry is a gap on the
    workflow side: show a grey "no source" badge so it gets noticed.
    """

    spec: MissionSpec = field(default_factory=MissionSpec)
    lap: int = 0
    history: list[LapRecord] = field(default_factory=list)
    latest_sizing: ConceptualSizingResult | None = None
    latest_loads: SparLoadsResult | None = None
    latest_spar: SparSizingResult | None = None
    latest_geometry: AircraftGeometry | None = None
    converged: bool = False
    infeasible_reason: str | None = None
    proposed_relaxation: SpecRelaxationProposal | None = None
    sources: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    provenance: dict[str, Provenance] = field(default_factory=dict)
    log: list[AgentLogEntry] = field(default_factory=list)
    components: dict[str, ComponentStatus] = field(default_factory=default_components)
    report_markdown: str | None = None


# ---------------------------------------------------------------------------
# 7. Boundary 2: API & SSE payloads (server/app.py <-> web/api_client.js)
# ---------------------------------------------------------------------------
#
#   POST /api/intake                 IntakeRequest  -> IntakeResponse
#   POST /api/spiral/run-sync        SpiralRequest  -> DesignState
#   POST /api/spiral/stream          SpiralRequest  -> SSE: lap/log ..., then converged | infeasible | error
#   POST /api/components/spar        StateRequest   -> DesignState (components.main_wing_spar filled)
#   POST /api/components/spar/stream StateRequest   -> SSE: component_step/log ..., then component_done | error
#   POST /api/components/{id}        StateRequest   -> DesignState (components.<id> filled)
#   POST /api/components/{id}/stream StateRequest   -> SSE: component_step/log ..., then component_done | error
#   POST /api/report                 StateRequest   -> ReportResponse
#   GET  /artifacts/{filename}                      -> files named in ComponentStatus.artifact_urls


@dataclass
class IntakeRequest(_Serialisable):
    description: str


@dataclass
class IntakeResponse(_Serialisable):
    spec: MissionSpec  # spec.defaulted_fields says which fields Gemini filled in, and why
    sources: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class SpiralRequest(_Serialisable):
    spec: MissionSpec


@dataclass
class StateRequest(_Serialisable):
    state: DesignState  # send back the last DesignState received, unchanged


@dataclass
class ReportResponse(_Serialisable):
    report_markdown: str
    state: DesignState


@dataclass
class LapEvent(_Serialisable):
    lap_record: LapRecord
    sizing: ConceptualSizingResult
    loads: SparLoadsResult
    spar: SparSizingResult
    geometry: AircraftGeometry


@dataclass
class LogEvent(_Serialisable):
    entry: AgentLogEntry


@dataclass
class ConvergedEvent(_Serialisable):
    state: DesignState


@dataclass
class InfeasibleEvent(_Serialisable):
    reason: str
    proposed_relaxation: SpecRelaxationProposal | None
    state: DesignState


@dataclass
class ComponentStepEvent(_Serialisable):
    component_id: str
    step: str  # "loads" | "sizing" | "cad" | "fea"
    status: str  # "running" | "done"


@dataclass
class ComponentDoneEvent(_Serialisable):
    component_id: str
    component: ComponentStatus
    state: DesignState


@dataclass
class ErrorEvent(_Serialisable):
    message: str
    tool_error: dict[str, Any] | None = None  # ToolError.to_dict() when a tool raised


SSE_EVENTS: dict[str, type] = {
    "lap": LapEvent,
    "log": LogEvent,
    "converged": ConvergedEvent,
    "infeasible": InfeasibleEvent,
    "component_step": ComponentStepEvent,
    "component_done": ComponentDoneEvent,
    "error": ErrorEvent,
}


def format_sse(event_type: str, payload: _Serialisable) -> str:
    """One SSE frame: `event: <type>\\ndata: <json>\\n\\n`."""
    if event_type not in SSE_EVENTS:
        raise ValueError(f"Unknown SSE event type: {event_type}")
    return f"event: {event_type}\ndata: {json.dumps(payload.to_dict())}\n\n"
