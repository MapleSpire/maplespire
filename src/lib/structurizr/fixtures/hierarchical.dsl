// Hierarchical identifiers with dotted relationship references, and two
// containers that share a short name across different systems.
workspace "Two Systems" {
    !identifiers hierarchical

    model {
        a = softwareSystem "System A" {
            web = container "Web" "UI" "React"
            api = container "API" "Logic" "Node"
        }
        b = softwareSystem "System B" {
            web = container "Web" "UI" "Vue"
            api = container "API" "Logic" "Python"
        }

        a.web -> a.api "Calls"
        a.api -> b.api "Integrates with" "gRPC"
        b.web -> b.api "Calls"
    }

    views {
        systemLandscape { include *  autoLayout }
        container a { include *  autoLayout }
        container b { include *  autoLayout }
    }
}
