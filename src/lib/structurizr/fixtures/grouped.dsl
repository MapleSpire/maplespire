// Groups, datastore detection, an external system, and a cycle (orders->bus->orders)
// to exercise group boxes, store mapping and cycle removal in layout.
workspace "Platform" {
    model {
        user = person "End User"

        group "Cloud" {
            api = softwareSystem "API Platform" {
                gateway = container "Gateway" "Edge routing" "Envoy"
                orders = container "Orders Service" "Order logic" "Java"
                inventory = container "Inventory Service" "Stock logic" "Java"
                cache = container "Cache" "Hot data" "Redis"
                bus = container "Message Bus" "Events" "RabbitMQ"
            }
            analytics = softwareSystem "Analytics" "Reporting & dashboards"
        }

        legacy = softwareSystem "Legacy ERP" "Old mainframe" "External"

        user -> gateway "Uses" "HTTPS"
        gateway -> orders "Routes"
        gateway -> inventory "Routes"
        orders -> cache "Caches"
        orders -> bus "Emits"
        inventory -> bus "Emits"
        bus -> orders "Triggers"
        orders -> legacy "Syncs"
        bus -> analytics "Feeds"
    }

    views {
        systemLandscape "Landscape" { include *  autoLayout lr }
        container api "ApiContainers" { include *  autoLayout }
    }
}
