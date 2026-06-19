// @vitest-environment jsdom

import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "test-utils/render-with-providers";

const { useWidgetAPI } = vi.hoisted(() => ({ useWidgetAPI: vi.fn() }));

vi.mock("utils/proxy/use-widget-api", () => ({
  default: useWidgetAPI,
}));

import Component from "./component";

describe("widgets/cyberpower/component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders error properly", () => {
    useWidgetAPI.mockReturnValue({
      data: undefined,
      error: "Error value"
    })

    const { container } = renderWithProviders(<Component service={{ widget: { type: "cyberpower" } }} />, {
      settings: { hideErrors: false },
    });

    expect(container.querySelectorAll(".service-block")).toHaveLength(0);
  });
  
  it("renders placeholders while loading", () => {
    useWidgetAPI.mockReturnValue({ data: undefined, error: undefined });

    const { container } = renderWithProviders(<Component service={{ widget: { type: "cyberpower" } }} />, {
      settings: { hideErrors: false },
    });

    expect(container.querySelectorAll(".service-block")).toHaveLength(4);
    expect(screen.getByText("cyberpower.status")).toBeInTheDocument();
    expect(screen.getByText("cyberpower.load")).toBeInTheDocument();
    expect(screen.getByText("cyberpower.capacity")).toBeInTheDocument();
    expect(screen.getByText("cyberpower.runtime")).toBeInTheDocument();
  });

  it("renders values when loaded", () => {
    useWidgetAPI.mockReturnValue({
      data: { 
        battery: {
          status: "Fully Charged",
          capacity: 100,
          runtime: 35
        },
        output: {
          load: 27
        }
      },
      error: undefined,
    });

    renderWithProviders(<Component service={{ widget: { type: "cyberpower" } }} />, { settings: { hideErrors: false } });

    expect(screen.getByText("Fully Charged")).toBeInTheDocument();
    expect(screen.getByText("27")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("35")).toBeInTheDocument();
  });
});
