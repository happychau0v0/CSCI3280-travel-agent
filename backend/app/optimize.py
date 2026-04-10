"""Route optimization helpers — TSP approximation for itinerary activities.

Uses nearest-neighbor as a fast initial solution then 2-opt local search to
improve it. Both are simple, deterministic, dependency-free, and fast enough
for the 5-15 stops a typical day-trip itinerary contains.
"""
from __future__ import annotations

import math
from typing import Sequence

# Mean Earth radius in km — used by haversine.
EARTH_RADIUS_KM = 6371.0


def haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in kilometers between two lat/lng points."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    c = 2 * math.asin(math.sqrt(a))
    return EARTH_RADIUS_KM * c


def total_distance(points: Sequence[tuple[float, float]], order: Sequence[int]) -> float:
    """Sum the haversine distance of consecutive points in the given order."""
    if len(order) < 2:
        return 0.0
    total = 0.0
    for i in range(len(order) - 1):
        a = points[order[i]]
        b = points[order[i + 1]]
        total += haversine(a[0], a[1], b[0], b[1])
    return total


def nearest_neighbor(points: Sequence[tuple[float, float]], start_idx: int = 0) -> list[int]:
    """Greedy nearest-neighbor TSP heuristic.

    Starts at `start_idx`, then repeatedly visits the closest unvisited point.
    Cheap (O(n^2)) but locally short-sighted — `two_opt_improve` cleans up
    the obvious mistakes.
    """
    n = len(points)
    if n == 0:
        return []
    if n == 1:
        return [0]

    visited = [False] * n
    order = [start_idx]
    visited[start_idx] = True

    while len(order) < n:
        current = order[-1]
        best_idx = -1
        best_dist = float("inf")
        for j in range(n):
            if visited[j]:
                continue
            d = haversine(points[current][0], points[current][1], points[j][0], points[j][1])
            if d < best_dist:
                best_dist = d
                best_idx = j
        order.append(best_idx)
        visited[best_idx] = True

    return order


def two_opt_improve(
    points: Sequence[tuple[float, float]],
    order: list[int],
    max_iter: int = 100,
) -> list[int]:
    """Improve an existing tour with 2-opt edge swaps.

    Repeatedly tries reversing each pair of edges; keeps the swap if it
    reduces total distance. Stops when a full pass produces no improvement
    or `max_iter` iterations are exhausted.
    """
    if len(order) < 4:
        return list(order)

    best = list(order)
    improved = True
    iteration = 0

    while improved and iteration < max_iter:
        improved = False
        iteration += 1
        # Try every pair of non-adjacent edges (i, i+1) and (j, j+1).
        # Reversing the segment [i+1..j] swaps those two edges.
        for i in range(len(best) - 2):
            for j in range(i + 2, len(best)):
                if j == len(best) - 1 and i == 0:
                    # Skip the trivial swap that just reverses the whole tour.
                    continue
                a, b = best[i], best[i + 1]
                c = best[j]
                d = best[j + 1] if j + 1 < len(best) else None
                if d is None:
                    continue
                old = (
                    haversine(points[a][0], points[a][1], points[b][0], points[b][1])
                    + haversine(points[c][0], points[c][1], points[d][0], points[d][1])
                )
                new = (
                    haversine(points[a][0], points[a][1], points[c][0], points[c][1])
                    + haversine(points[b][0], points[b][1], points[d][0], points[d][1])
                )
                if new + 1e-9 < old:
                    best[i + 1 : j + 1] = reversed(best[i + 1 : j + 1])
                    improved = True

    return best


def optimize_order(points: Sequence[tuple[float, float]]) -> tuple[list[int], float, float]:
    """Compute an optimized visit order for the given points.

    Returns (ordered_indices, distance_before_km, distance_after_km).
    `distance_before` measures the original input order so the caller can
    show savings.
    """
    n = len(points)
    if n < 2:
        return list(range(n)), 0.0, 0.0

    original = list(range(n))
    before = total_distance(points, original)

    initial = nearest_neighbor(points, start_idx=0)
    improved = two_opt_improve(points, initial)
    after = total_distance(points, improved)

    # If the improved tour is somehow worse than the original (rare but
    # possible when input is already optimal), fall back to the original.
    if after >= before - 1e-9:
        return original, before, before

    return improved, before, after
