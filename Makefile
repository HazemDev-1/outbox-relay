.PHONY: install lint typecheck test check build

install:
	npm ci

lint:
	npm run lint

typecheck:
	npm run typecheck

test:
	npm test

build:
	npm run build

check: lint typecheck test
