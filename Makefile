# Bitget Agent MCP - npm publish entry points for the Bitget Spug EC2 publisher.
#
# Local developers DO NOT run these targets. They run only on the dedicated
# EC2 publisher with KMS decrypt permission (N10) and outbound network
# permission to registry.npmjs.org (G19).

.PHONY: build-kms publish-npm clean-npmrc

build-kms:
	cd kms && pnpm install --frozen-lockfile && pnpm run build

publish-npm: clean-npmrc
	cd kms && pnpm run kms-run
	cp kms/.npmrc .npmrc
	npm publish --access public
	$(MAKE) clean-npmrc

clean-npmrc:
	rm -f .npmrc kms/.npmrc
