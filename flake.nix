{
  description = "Description for the project";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    devenv = {
      url = "github:cachix/devenv";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    mithril = {
      url = "github:input-output-hk/mithril";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.devenv.flakeModule
        inputs.treefmt-nix.flakeModule
      ];
      systems = [ "x86_64-linux" ];
      perSystem = { config, self', inputs', pkgs, system, lib, ... }: {
        treefmt = {
          projectRootFile = "flake.nix";
          programs.deno.enable = true;
        };

        devenv.shells.default = {
          packages = with pkgs; [
            lmdb
            sqlite
            poppler-utils
            inputs.mithril.packages.${system}.mithril-client-cli
          ];

          languages = {
            typescript.enable = true;
            javascript = {
              enable = true;
              bun.enable = true;
            };
          };
        };
      };
    };
}
