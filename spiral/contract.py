"""Frozen contract between Harry (Agent & Server) and Tharm (Aerostructures, FEA & Frontend).

Conventions:
- SI units everywhere (kg, m, s, N, W, Pa, J). Field names carry unit suffixes.
- Tools are pure, deterministic Python functions returning ToolResult[T] or raising ToolError.
- Never return NaN or silently clamp; out-of-range inputs compute and append to warnings.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Generic, TypeVar

T = TypeVar("T")


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
class ToolResult(Generic[T]):
    """Standard envelope returned by every deterministic tool in spiral.tools."""

    value: T
    sources: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# 1. Mission Specification (Intake Output)
# ---------------------------------------------------------------------------


@dataclass
class MissionSpec:
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
    aspect_ratio: float = 7.5
    taper_ratio: float = 0.6
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
    defaulted_fields: dict[str, str] = field(default_factory=dict)

    @property
    def n_ult(self) -> float:
        return self.limit_load_factor * self.ultimate_factor

    @property
    def payload_mass_kg(self) -> float:
        return (self.crew_count + self.passenger_count) * self.person_mass_kg + self.baggage_mass_kg

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MissionSpec:
        valid_keys = {f.name for f in cls.__dataclass_fields__.values()}
        filtered = {k: v for k, v in data.items() if k in valid_keys}
        return cls(**filtered)


# ---------------------------------------------------------------------------
# 2. Conceptual Sizing Contract (spiral.tools.sizing)
# ---------------------------------------------------------------------------


@dataclass
class ConceptualSizingResult:
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
    segment_fractions: dict[str, float] = field(default_factory=dict)
    mass_breakdown_kg: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ConceptualSizingResult:
        return cls(**data)


# ---------------------------------------------------------------------------
# 3. Preliminary Spar Loads & Sizing Contract (spiral.tools.spar)
# ---------------------------------------------------------------------------


@dataclass
class SparStationLoad:
    """Spanwise load station from y=0 (root) to y=b/2 (tip)."""

    y_m: float
    chord_m: float
    elliptical_lift_n_per_m: float
    planform_lift_n_per_m: float
    schrenk_lift_n_per_m: float
    shear_n: float
    moment_nm: float


@dataclass
class SparLoadsResult:
    """Output of spar_loads()."""

    n_ult: float
    semi_span_m: float
    root_shear_n: float
    root_moment_nm: float
    stations: list[SparStationLoad] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SparLoadsResult:
        stations = [
            s if isinstance(s, SparStationLoad) else SparStationLoad(**s)
            for s in data.get("stations", [])
        ]
        return cls(
            n_ult=data["n_ult"],
            semi_span_m=data["semi_span_m"],
            root_shear_n=data["root_shear_n"],
            root_moment_nm=data["root_moment_nm"],
            stations=stations,
        )


@dataclass
class SparStationSection:
    """Spanwise I-beam section dimensions and stresses from y=0 (root) to y=b/2 (tip)."""

    y_m: float
    depth_m: float
    cap_area_m2: float
    cap_width_m: float
    cap_thickness_m: float
    web_thickness_m: float
    bending_stress_pa: float
    shear_stress_pa: float
    deflection_m: float


@dataclass
class SparSizingResult:
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
    safety_margin: float
    tip_deflection_m: float
    stations: list[SparStationSection] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SparSizingResult:
        stations = [
            s if isinstance(s, SparStationSection) else SparStationSection(**s)
            for s in data.get("stations", [])
        ]
        return cls(
            material_key=data["material_key"],
            mass_both_wings_kg=data["mass_both_wings_kg"],
            semi_span_mass_kg=data["semi_span_mass_kg"],
            root_depth_m=data["root_depth_m"],
            tip_depth_m=data["tip_depth_m"],
            root_cap_area_m2=data["root_cap_area_m2"],
            root_cap_width_m=data["root_cap_width_m"],
            root_cap_thickness_m=data["root_cap_thickness_m"],
            root_web_thickness_m=data["root_web_thickness_m"],
            max_bending_stress_pa=data["max_bending_stress_pa"],
            max_shear_stress_pa=data["max_shear_stress_pa"],
            allowable_yield_stress_pa=data["allowable_yield_stress_pa"],
            safety_margin=data["safety_margin"],
            tip_deflection_m=data["tip_deflection_m"],
            stations=stations,
        )


# ---------------------------------------------------------------------------
# 4. Detailed CAD & FEA Contract (spiral.tools.cad, spiral.tools.fea)
# ---------------------------------------------------------------------------


@dataclass
class SparCadResult:
    """Output of build_spar_cad()."""

    step_path: str
    stl_path: str
    volume_single_wing_m3: float
    cad_mass_both_wings_kg: float
    bounding_box_m: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SparCadResult:
        return cls(**data)


@dataclass
class FeaStationResult:
    """Spanwise comparison between 3D FEA and Euler-Bernoulli beam theory."""

    y_m: float
    fea_von_mises_pa: float
    beam_stress_pa: float
    fea_deflection_m: float
    beam_deflection_m: float


@dataclass
class FeaResult:
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

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> FeaResult:
        stations = [
            s if isinstance(s, FeaStationResult) else FeaStationResult(**s)
            for s in data.get("stations", [])
        ]
        return cls(
            solver_name=data["solver_name"],
            fea_max_von_mises_pa=data["fea_max_von_mises_pa"],
            fea_tip_deflection_m=data["fea_tip_deflection_m"],
            beam_max_stress_pa=data["beam_max_stress_pa"],
            beam_tip_deflection_m=data["beam_tip_deflection_m"],
            stress_agreement_pct=data["stress_agreement_pct"],
            deflection_agreement_pct=data["deflection_agreement_pct"],
            safety_margin_fea=data["safety_margin_fea"],
            stress_mesh_path=data.get("stress_mesh_path"),
            stations=stations,
        )


# ---------------------------------------------------------------------------
# 5. 3D Aircraft Geometry Contract (spiral.tools.geometry)
# ---------------------------------------------------------------------------


@dataclass
class AircraftGeometry:
    """Parametric Three.js primitives (all dimensions in metres)."""

    fuselage: dict[str, float] = field(default_factory=dict)
    wing: dict[str, float | str] = field(default_factory=dict)
    horizontal_tail: dict[str, float] = field(default_factory=dict)
    vertical_tail: dict[str, float] = field(default_factory=dict)
    propeller: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AircraftGeometry:
        return cls(**data)


# ---------------------------------------------------------------------------
# 6. DesignState & Orchestrator / API Schemas
# ---------------------------------------------------------------------------


@dataclass
class LapRecord:
    """Summary of a single lap around the design spiral."""

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

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AgentLogEntry:
    """Traceable agent decision or calculation log item."""

    lap: int
    stage: str  # "intake" | "conceptual" | "preliminary" | "convergence" | "detailed" | "report"
    message: str
    citations: list[str] = field(default_factory=list)
    level: str = "info"  # "info" | "warning" | "error"


@dataclass
class SpecRelaxationProposal:
    """Gemini's single proposed parameter relaxation when the spiral is infeasible."""

    field_name: str
    old_value: float
    new_value: float
    unit: str
    reasoning: str
    estimated_mtow_kg: float | None = None


@dataclass
class ComponentStatus:
    """Detailed design status for a structural component."""

    component_id: str
    name: str
    available: bool  # True for "main_wing_spar", False ("coming soon") for others
    status: str = "pending"  # "pending" | "running_cad" | "running_fea" | "completed" | "coming_soon"
    cad: SparCadResult | None = None
    fea: FeaResult | None = None


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
            name="Main Landing Gear Strut",
            available=False,
            status="coming_soon",
        ),
        "horizontal_tail": ComponentStatus(
            component_id="horizontal_tail",
            name="Horizontal Tail Spar",
            available=False,
            status="coming_soon",
        ),
        "engine_mount": ComponentStatus(
            component_id="engine_mount",
            name="Engine Mount Truss",
            available=False,
            status="coming_soon",
        ),
        "fuselage_frames": ComponentStatus(
            component_id="fuselage_frames",
            name="Wing Carry-Through Fuselage Frames",
            available=False,
            status="coming_soon",
        ),
    }


@dataclass
class DesignState:
    """Complete state of a design spiral session."""

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
    log: list[AgentLogEntry] = field(default_factory=list)
    components: dict[str, ComponentStatus] = field(default_factory=default_components)
    report_markdown: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
