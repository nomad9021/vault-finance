//! Geometry for `TrendChart` (apps/desktop/src/screens/shell/TrendChart.tsx):
//! the least-squares projection and the SVG paths, number for number.

/// `Math.round`: halves go toward +∞.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `Number.prototype.toFixed(1)` for the non-negative coordinates the chart
/// produces. Rust rounds exact ties to even; JS picks the larger, so ties
/// (only ever x.25 / x.75 in binary) are nudged up.
pub fn to_fixed1(x: f64) -> String {
    let q = x * 4.0;
    let tie = q.fract() == 0.0 && (q as i64).rem_euclid(2) == 1;
    let s = if tie {
        format!("{:.1}", x + 0.05)
    } else {
        format!("{x:.1}")
    };
    if s == "-0.0" {
        "0.0".into()
    } else {
        s
    }
}

/// `project(vals, count)`: least-squares linear projection of `count`
/// future points.
pub fn project(vals: &[i64], count: usize) -> Vec<i64> {
    let n = vals.len();
    if n == 0 {
        return vec![0; count];
    }
    if n == 1 {
        return vec![vals[0]; count];
    }
    let nf = n as f64;
    let xm = (nf - 1.0) / 2.0;
    let ym = vals.iter().fold(0.0, |a, &b| a + b as f64) / nf;
    let (mut num, mut den) = (0.0, 0.0);
    for (i, &v) in vals.iter().enumerate() {
        let dx = i as f64 - xm;
        num += dx * (v as f64 - ym);
        den += dx.powi(2);
    }
    let slope = if den != 0.0 { num / den } else { 0.0 };
    let intercept = ym - slope * xm;
    (0..count)
        .map(|k| js_round(intercept + slope * (nf + k as f64)) as i64)
        .collect()
}

pub const WIDTH: f64 = 600.0;
const PAD: f64 = 6.0;

/// The three paths and the end dot. `None` when there are fewer than two
/// history points (the chart shows its empty label instead).
#[derive(Debug, Clone, PartialEq)]
pub struct TrendPaths {
    pub hist: String,
    pub proj: String,
    pub area: String,
    pub dot: (f64, f64),
}

pub fn paths(history: &[i64], projected: &[i64], height: f64) -> Option<TrendPaths> {
    if history.len() < 2 {
        return None;
    }
    let all: Vec<f64> = history.iter().chain(projected).map(|&v| v as f64).collect();
    let min = all.iter().copied().fold(f64::INFINITY, f64::min);
    let max = all.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let span = if max - min == 0.0 { 1.0 } else { max - min };
    let h = height;
    let x = |i: usize| PAD + (i as f64 / (all.len() - 1) as f64) * (WIDTH - 2.0 * PAD);
    let y = |v: f64| h - PAD - ((v - min) / span) * (h - 2.0 * PAD);
    let pt = |i: usize, v: f64| format!("{},{}", to_fixed1(x(i)), to_fixed1(y(v)));
    let last = history.len() - 1;
    let hist = history
        .iter()
        .enumerate()
        .map(|(i, &v)| format!("{}{}", if i == 0 { "M" } else { "L" }, pt(i, v as f64)))
        .collect::<Vec<_>>()
        .join(" ");
    let mut proj = vec![format!("M{}", pt(last, history[last] as f64))];
    proj.extend(
        projected
            .iter()
            .enumerate()
            .map(|(k, &v)| format!("L{}", pt(last + 1 + k, v as f64))),
    );
    let base = to_fixed1(h - PAD);
    let area = format!(
        "{hist} L{},{base} L{},{base} Z",
        to_fixed1(x(last)),
        to_fixed1(x(0))
    );
    Some(TrendPaths {
        hist,
        proj: proj.join(" "),
        area,
        dot: (x(last), y(history[last] as f64)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_matches_js() {
        // (0.25).toFixed(1) === "0.3", (2.75).toFixed(1) === "2.8", (79.5).toFixed(1) === "79.5"
        assert_eq!(to_fixed1(0.25), "0.3");
        assert_eq!(to_fixed1(42.25), "42.3");
        assert_eq!(to_fixed1(2.75), "2.8");
        assert_eq!(to_fixed1(79.5), "79.5");
        assert_eq!(to_fixed1(6.0), "6.0");
        assert_eq!(to_fixed1(173.33333333333334), "173.3");
    }

    #[test]
    fn projection() {
        assert_eq!(project(&[], 3), [0, 0, 0]);
        assert_eq!(project(&[7], 2), [7, 7]);
        assert_eq!(project(&[10, 20, 30], 3), [40, 50, 60]);
        // Reference values from the TS implementation in node.
        assert_eq!(project(&[0, 0, 1, 1], 3), [2, 2, 2]);
        assert_eq!(
            project(&[1520000, 1548117, 1501234, 1600000, 1598000], 3),
            [1615835, 1636623, 1657412]
        );
        assert_eq!(project(&[-1, -2], 1), [-3]);
    }

    #[test]
    fn paths_like_ts() {
        assert_eq!(paths(&[5], &[], 180.0), None);
        let p = paths(&[0, 100], &[200], 66.0).unwrap();
        // x: 6, 300, 594; y: 60, 33, 6
        assert_eq!(p.hist, "M6.0,60.0 L300.0,33.0");
        assert_eq!(p.proj, "M300.0,33.0 L594.0,6.0");
        assert_eq!(p.area, "M6.0,60.0 L300.0,33.0 L300.0,60.0 L6.0,60.0 Z");
        assert_eq!(p.dot, (300.0, 33.0));
        // Flat series: span falls back to 1, everything sits on the baseline.
        let flat = paths(&[3, 3], &[], 66.0).unwrap();
        assert_eq!(flat.hist, "M6.0,60.0 L594.0,60.0");
    }
}
