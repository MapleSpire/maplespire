workspace "Ambiguous identifiers" "Two systems that reuse the same container identifiers." {

    !identifiers hierarchical

    model {
        alpha = softwareSystem "Alpha" {
            web = container "Alpha Web" "Alpha's front end"
            api = container "Alpha API" "Alpha's back end" {
                controller = component "Alpha Controller"
            }
            web -> api "Alpha web calls Alpha api"
        }

        beta = softwareSystem "Beta" {
            web = container "Beta Web" "Beta's front end"
            api = container "Beta API" "Beta's back end" {
                controller = component "Beta Controller"
            }
            web -> api "Beta web calls Beta api"
        }

        alpha.api.controller -> beta.api.controller "Three-level reference across systems"
    }

    views {
        container alpha "AlphaContainers" {
            include *
            autoLayout
        }
        container beta "BetaContainers" {
            include *
            autoLayout
        }
    }
}
