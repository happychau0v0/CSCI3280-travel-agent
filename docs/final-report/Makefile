SOURCES_DIR := figures/sources
FIGURES_DIR := figures
PDFLATEX    := pdflatex -interaction=nonstopmode

FIGURES := f1-architecture f2-pipeline f3-sse-timeline \
           f4-bench-scatter f5-stage-latency f6-state-machine

.PHONY: figures clean-figures

figures: $(addprefix $(FIGURES_DIR)/,$(addsuffix .pdf,$(FIGURES)))

$(FIGURES_DIR)/%.pdf: $(SOURCES_DIR)/%.tex
	mkdir -p $(FIGURES_DIR)
	cd $(SOURCES_DIR) && $(PDFLATEX) -output-directory ../../$(FIGURES_DIR) $*.tex
	rm -f $(FIGURES_DIR)/$*.aux $(FIGURES_DIR)/$*.log

clean-figures:
	rm -f $(addprefix $(FIGURES_DIR)/,$(addsuffix .pdf,$(FIGURES)))
