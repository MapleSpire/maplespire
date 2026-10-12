workspace "[SN] SAOE" "Architecture d'intégration entre l'application REQ et Microsoft Field Service" {

    model {
        # Acteurs
        inspecteur = person "Inspecteur" "Inspecteur terrain utilisant Field Service" "Utilisateur"
        repartiteur = person "Répartiteur" "Planifie le travail en utilisant Field Service Web" "Utilisateur"
        agent = person "Agent" "gère les opérations" "Utilisateur"
        organization = person "Organisation" "Entreprise externe désirant un permis" "Utilisateur"
        secretaire = person "Secretaire" "approuve pour le directeur" "Utilisateur"
        directeur = person "Directeur" "approuve" "Utilisateur"
        employeeVille = person "Employé" "Gère les opérations SAOE" "Utilisateur"
        ingenieur = person "Ingénieur" "approuve et analyse les demandes" "Utilisateur"
        utilisateurREQ = person "Utilisateur" "Employé utilisant l'application web" "Utilisateur"
        #administrateur = person "Administrateur" "Administrateur système" "Admin"

        ssgae = softwareSystem "Système GAE" {
            of = container "Oracle Form" {
                etabModule = component "Module établissements" "Gestion des établissements qui inclue les contacts" "Component"
                activitybModule = component "Module activités" "Gestion des activités (Avis, Visites, prélèvement, etc..)" "Component"
                caseModule = component "Module plaintes" "Gestion des plaintes" "Component"
                reqModule = component "Module demande de permis" "Gestion des demandes" "Component"
                ptModule = component "Module permis" "Gestion des permis" "Component"
                docModule = component "Module documents" "Gestion des documents" "Component"
                reqPrevModule = component "Module Prélèvement" "Gestion des prélèvements" "Component"
                caracModule = component "Module de caractérisation" "Gestion des caractérisations" "Component"
                poursuiteModule = component "Module poursuite" "Gestion des poursuite" "Component"
                reportModule = component "Module de rapport" "Génération des rapports" "Component"
                printModule = component "Module d'impression" "Impression de documents" "Component"
            }
            db = container "Database Oracle" {
                tags "Database"
            }
        }
        ssreps = softwareSystem "Système de répertoires partagés S" {
                reps = container "Répertoires"
        }
        ssechant = softwareSystem "Système d'échantillonnage en dehors de GAE" {
                scripts = container "scripts"
                excels = container "fichiers Excels"
        }
        ssinsp = softwareSystem "Système d'inspections en dehors de GAE" {
                files = container "fichiers Excels, PDF, Words"
        }
        ssrepg = softwareSystem "Système de répertoires partagés G" {
                reppublic = container "PUBLIC"
                repprivate = container "PRIVE"
        }

        # Systèmes externes
        registreREQ = softwareSystem "Registre des Entreprises du Québec" "Source officielle des données d'entreprises" "External"
        azure = softwareSystem "Azure Services" "Services cloud Microsoft Azure" "External"
        powerPlatform = softwareSystem "Power Platform" "Microsoft Power Platform (Dataverse, Power Automate)" "External"
        aws = softwareSystem "AWS Services" "Services cloud AWS" "External"
        consigno = softwareSystem "Consigno" "Gestion des signatures" "External"
        dci = softwareSystem "DCI" "Dossiers citoyens intégrés" "External"

        # Système SAOE Permis
        reqSystem = softwareSystem "SAOE Permis" "Application de dépôt des demandes SAOE" {

            # Frontend
            angularEmployeeApp = container "Angular Web App - Employé" "Application web Angular pour le module permis" "Angular 17, TypeScript" "Web Browser" {
                enterpriseModule = component "Enterprise Module" "Gestion des entreprises" "Angular Component"
                buildingModule = component "Building Module" "Gestion des bâtiments" "Angular Component"
                documentModule = component "Document Module" "Gestion des documents" "Angular Component"
            }
            angularCitizenApp = container "Angular Web App - Citoyen" "Application web Angular pour le module permis" "Angular 17, TypeScript" "Web Browser"
            # Backend API
            nodeAPI = container "Node.js API" "API REST pour opérations REQ" "Node.js 20, Express, TypeScript" "API" {
                enterpriseController = component "Enterprise Controller" "Endpoints entreprises" "Express Controller"
                buildingController = component "Building Controller" "Endpoints bâtiments" "Express Controller"
                placesController = component "Places Controller" "Endpoints des lieux" "Express Controller"
                webhookController = component "Webhook Controller" "Réception notifications changements" "Express Controller"
            }

            # Base de données
            postgresql = container "PostgreSQL Database" "Stockage données REQ" "PostgreSQL 15" "Database" {
                enterprisesTable = component "enterprises" "Table entreprises" "Table"
                buildingsTable = component "buildings" "Table bâtiments" "Table"
                placesTable = component "places" "Table lieux" "Table"
                contactsTable = component "contacts" "Table contacts" "Table"
                syncLogTable = component "field_service_sync_log" "Log synchronisation" "Table"
            }
            elasticsearch = container "Elasticsearch" "Recherche les demandes et les permis" "Elasticsearch" "Database"
            # Worker de synchronisation
            syncWorker = container "Sync Worker" "Worker de synchronisation asynchrone" "Node.js, AWS SDK" "Worker"
        }

        # Système Field Service
        powerPlatformSystem = softwareSystem "Microsoft Power Platform SAOE" "Réside les applications de gestion pour les employés" "Microsoft Azure - Power Platform" {

            # Dataverse
            dataverse = container "Dataverse" "Base de données Dynamics 365" "Dataverse" "Database" {
                reqEnterprises = component "account (parent)" "Entreprises REQ (read-only)" "Standard Table"
                reqBuildings = component "account (child)" "Bâtiments REQ (read-only)" "Standard Table"
                reqPlaces = component "msdyn_functionallocation" "Lieux REQ (read-only)" "Standard Table"
                reqContacts = component "contact" "Contacts REQ (read-only)" "Standard Table"
                inspectionAttachment = component "msdyn_inspectionattachment" "Métadonnées documents rattachés à la réponse de formulaire" "Standard Table"
                question = component "msfp_question" "Configuration des questions des formulaires" "Standard Table"
                surveyResponse = component "msfp_surveyresponse" "réponses aux inspections" "Standard Table"
                questionResponse = component "msfp_questionresponse" "Réponse individuel pour chaque question des formulaires d'inspection" "Standard Table"
                inspectionResponse = component "msdyn_inspectionresponse" "Contenu du formulaire sous format JSON" "Standard Table"
                remarque = component "annotation" "Contenu du document" "Standard Table"
                workOrders = component "msdyn_workorder" "Ordres de travail" "Standard Table"
                incident = component "incident" "Table des plaintes (Case)" "Standard Table"
            }

            # Power Automate
            powerAutomate = container "Power Automate Flows" "Flux d'automatisation" "Power Automate" "Microsoft Azure - Workflow"  {
                syncFlow = component "REQ Sync Flow" "Synchronise données REQ" "Cloud Flow"
                archiveFlow = component "Archive Documents Flow" "Archive vers SharePoint" "Scheduled Flow"
                notificationFlow = component "Notification Flow" "Notifie changements" "Cloud Flow"
                complaintSLAFlow = component "Complaint SLA Flow" "Gère les délais 24h/10j et notifications" "Cloud Flow"
            }

            # Field Service Mobile
            fsMobile = container "Application mobile d'inspection" "Application mobile pour les activités sur le terrain" "Power Apps Mobile" "Mobile" {
                offlineDb = component "Offline Database" "Cache local SQLite" "SQLite"
                pcfDocViewer = component "Document Viewer PCF" "Composant visualisation documents" "PCF Component"
                workOrderForm = component "Work Order Form" "Formulaire ordre de travail" "Model-driven Form"
                complaintForm = component "Complaint Form" "Formulaire de consultation plainte" "Model-driven Form"
            }

            # Gestion des activités Web Portal
            saoeWeb = container "SAOE Gestion Web" "Portail web pour la gestion des activités (Demandes, Plaintes, Entreprises, Planifications, etc.)" "Power Apps" "Web Browser" {
                demandePermis = component "Process permit request" "Demandes de permis" "Gestion des demandes"
                gestionPlaintes = component "Gestion des Plaintes" "Module de saisie et suivi des plaintes" "Model-driven App Module"
                schedulingBoard = component "Scheduling Board" "Planification" "Schedule Board"
            }
        }

        # Infrastructure Azure
        azureInfraSystem = softwareSystem "Azure Infrastructure Ville" "Infrastructure cloud Azure" "Microsoft Azure - Azure Deployment Environments" {
            appInsights = container "Microsoft App insights" "Observe et surveille" "Microsoft Azure - Application Insights" "Microsoft Azure - Application Insights" {
                LogModule = component "Logue" "Gestion des logues" "Component" "Microsoft Azure - Activity Log"
                alertModule = component "Alerte" "Gestion des alertes" "Component" "Microsoft Azure - Alerts"
            }
        }
        # Infrastructure Ville
        montrealInfraSystem = softwareSystem "Infrastructure Ville" "Infrastructure Ville" "Interne" {
            jaeger = container "Jaeger" "Observe et surveille" "Jaeger" "Interne"
            grafana = container "Grafana" "Observe et surveille les tableaux de bords" "Grafana" "Interne"
            loki = container "Loki" "Observe et surveille les logues" "Loki" "Interne"
            prometheus = container "Prometheus" "Gestion des alertes en fonction des métriques" "Prometheus" "Interne"
        }

        # Infrastructure AWS
        awsInfraSystem = softwareSystem "AWS Infrastructure" "Infrastructure cloud AWS" {
            sqs = container "AWS Queue Service" "Queue de messages pour sync asynchrone" "Queue Standard" "Queue"
            s3 = container "AWS S3" "Stockage fichiers (backend)" "AWS Storage" "Storage"
            stepfunction = container "AWS Step function" "Orchestration de workers" "Step functions" "SaaS"
        }

        # SharePoint
        sharePoint = softwareSystem "SharePoint Online" "Stockage documents. À valider" "SharePoint" {
            documentLibrary = container "REQ Documents Library" "Bibliothèque documents REQ" "SharePoint Library" "Storage"
        }

        # Relations entre acteurs et systèmes
        inspecteur -> fsMobile "Effectue les activités sur le terrain " "HTTPS"
        inspecteur -> saoeWeb "Modifie la planification" "HTTPS"
        repartiteur -> saoeWeb "Planifie le travail" "HTTPS"
        employeeVille -> angularEmployeeApp "Consulte/dépose le permis final" "HTTPS"
        employeeVille -> angularEmployeeApp "consulte les détails de la demande ou du permis" "HTTPS"
        organization -> angularCitizenApp "dépose/consulte les détails de la demande ou du permis" "HTTPS"
        employeeVille -> saoeWeb "consulte les données reliées à l'établissement" "HTTPS"
        employeeVille -> consigno "signe les permis" "HTTPS"
        employeeVille -> saoeWeb "traite les demandes de permis" "HTTPS"
        employeeVille -> saoeWeb "saisie les plaintes" "HTTPS"
        #administrateur -> saoeWeb "Configure Field Service" "HTTPS"
        #administrateur -> powerAutomate "Gère flux automatisation" "HTTPS"
        #administrateur -> appInsights "Observe et surveille" "HTTPS"
        #administrateur -> jaeger "Observe et surveille les traces" "HTTPS"
        #administrateur -> grafana "Observe les tableaux de bords" "HTTPS"
        #administrateur -> prometheus "définit les alertes" "HTTPS"
        #administrateur -> loki "Observe les logues" "HTTPS"

        #GAE Actuel
        employeeVille -> of "Utilise"
        employeeVille -> reps "Utilise"
        employeeVille -> excels "Utilise"
        employeeVille -> files "Utilise"
        #employeeVille -> activitybModule "met à jour les activités"
        of -> db "lit de et écrit à"
        of -> repprivate "sauvegarde/lit les fichiers déposés"
        #ssgae.of -> reps "dépose manuellement vers le S (employé)"
        scripts -> db "le script met à jour les dates des activités"
        #db -> reps "aucun lien, c'est l'employé qui fait le lien"
        scripts -> reppublic "lit les activités des fichiers Excels"
        excels -> reppublic "Les fichiers sont sauvegardés manuellement dans"
        files -> activitybModule "engendre des mises à jours manuelles"
        files -> reps "les fichiers sont entreposés dans"
        etabModule -> activitybModule "énumère, planifie"
        etabModule -> caseModule "génère"
        etabModule -> docModule "possède"
        etabModule -> reqModule "soumet"
        etabModule -> ptModule "possède"
        etabModule -> reqPrevModule "possède"
        etabModule -> poursuiteModule "est accusé"
        reqModule -> ptModule "reliée a"
        ptModule -> docModule "possède"
        ptModule -> activitybModule "contient"
        reqPrevModule -> caracModule "contient des"
        caseModule -> activitybModule "contient"

        # Relations système REQ
        angularEmployeeApp -> nodeAPI "Appelle API" "HTTPS/REST"
        angularCitizenApp -> nodeAPI "Appelle API" "HTTPS/REST"
        angularCitizenApp -> dci "redirige vers le tunnel" "HTTPS/REST"
        nodeAPI -> postgresql "Lit/Écrit données" "TCP/5432"
        nodeAPI -> elasticsearch "recherche dans les données" "HTTPS/REST"
        nodeAPI -> dci "valide le profil" "HTTPS/REST"

        # Triggers PostgreSQL
        # postgresql -> syncWorker "NOTIFY changements" "PostgreSQL LISTEN/NOTIFY"

        # Sync Worker
        syncWorker -> postgresql "CRUD données complètes" "TCP/5432"
        syncWorker -> nodeAPI "Pour les opérations standards" "TCP/5432"
        syncWorker -> elasticsearch "Index les données" "HTTPS/REST"

        # Power Automate vers Dataverse/API
        powerAutomate -> dataverse "Crée/Met à jour entités" "Dataverse Web API"
        powerAutomate -> documentLibrary "Crée dossiers/fichiers" "HTTPS"
        powerAutomate -> nodeAPI "notifie des changements"
        dataverse -> sharePoint "Contient les documents sur les entreprises et établissement" "SharePoint REST API"

        # Field Service Mobile
        fsMobile -> dataverse "Synchronise données" "Dataverse Offline Sync"
        # AJOUT POUR LE FLUX DYNAMIQUE : RELATION INVERSE NECESSAIRE
        dataverse -> fsMobile "Envoie mises à jour" "Dataverse Offline Sync"

        pcfDocViewer -> dataverse "Télécharge fichiers actifs" "Dataverse File API"
        # pcfDocViewer -> blobStorage "Via Dataverse" "HTTPS"

        # Field Service Web
        saoeWeb -> dataverse "CRUD opérations" "Dataverse Web API"

        # App Insights
        powerPlatformSystem -> appInsights "Envoie la télémetrie" "https"
        alertModule -> logModule "Analyse les logues" "https"

        # Relations avec systèmes externes
        syncWorker -> registreREQ "Importe mises à jour" "https/csv"
        syncWorker -> sqs "Consomme messages" "https"
        syncWorker -> stepfunction "acknowledge" "https"
        syncWorker -> dataverse "Envoie données via ODATA" "HTTPS"
        syncWorker -> consigno "Envoi le permis pour signature" "HTTPS"
        stepfunction -> sqs "Envoie les données"
        consigno -> nodeAPI "notifie quand le permis est signé" "HTTPS"
        dataverse -> nodeAPI "notifie lors du changement de statut (webhooks)" "HTTPS"
        # Relations composants internes

        # Angular App
        enterpriseModule -> enterpriseController "GET/POST/PUT enterprises" "HTTPS/REST"
        buildingModule -> buildingController "GET/POST/PUT buildings" "HTTPS/REST"

        # Node.js API
        enterpriseController -> enterprisesTable "CRUD" "Sequelize ORM"
        buildingController -> buildingsTable "CRUD" "Sequelize ORM"

        # Power Automate
        syncFlow -> reqEnterprises "Upsert entreprises" "Dataverse API"
        syncFlow -> reqBuildings "Upsert bâtiments" "Dataverse API"
        syncFlow -> reqPlaces "Upsert lieux" "Dataverse API"
        syncFlow -> reqContacts "Upsert contacts" "Dataverse API"

        # --- Relations flux Plainte ---
        complaintSLAFlow -> incident "Surveille création/Met à jour statut" "Dataverse API"
        complaintSLAFlow -> agent "Notifie (Courriel)" "Exchange"
        complaintSLAFlow -> inspecteur "Notifie (Courriel)" "Exchange"

        #archiveFlow -> documentMetadata "Lit anciens docs" "Dataverse API"
        #archiveFlow -> documentLibrary "Copie fichiers" "SharePoint API"
        #archiveFlow -> documentMetadata "Met à jour statut=archived" "Dataverse API"

        # Dataverse relations
        reqEnterprises -> reqBuildings "0:N relation" "Lookup"
        reqBuildings -> reqPlaces "0:N relation" "Lookup"
        reqEnterprises -> reqContacts "0:N relation" "Lookup"
        workOrders -> inspectionResponse "0:N relation" "through msdyn_taskrelativeworkorders"
        inspectionResponse -> surveyResponse "1:N relation" "Lookup"
        surveyResponse -> questionResponse "1:N relation" "Lookup"
        questionResponse -> question "1:1 relation" "Lookup"
        inspectionResponse -> inspectionAttachment "0:N relation" "Lookup"
        inspectionAttachment -> remarque "1:1 relation" "Lookup"
        workOrders -> reqBuildings "1:1 relation" "Lookup"

        # --- Relations Dataverse Plainte ---
        incident -> reqEnterprises "Lié à l'établissement" "Lookup"
        incident -> reqContacts "Lié au plaignant" "Lookup"
        workOrders -> incident "Inspection découlant de la plainte" "Lookup"
        incident -> reqPlaces "Lié au lieu d'activité" "Lookup"

        # Field Service Mobile offline
        offlineDb -> reqEnterprises "Sync offline" "Dataverse Offline"
        offlineDb -> reqBuildings "Sync offline" "Dataverse Offline"
        offlineDb -> workOrders "Sync offline" "Dataverse Offline"

        # --- Sync Offline Plainte ---
        offlineDb -> incident "Sync offline (Plaintes assignées)" "Dataverse Offline"

        # Relation composant interne SGA
        gestionPlaintes -> incident "CRUD Plaintes" "Dataverse Web API"
        gestionPlaintes -> reqEnterprises "CRUD Entreprises/Établissements" "Dataverse Web API"
        complaintForm -> offlineDb "Lit/Modifie" "Local Access"
    }

    views {

        systemContext ssgae "DiagramContextGAE" {
            include *
        }
        systemContext ssreps "DiagramContextRepS" {
            include *
        }
        container ssechant "DiagramLevel2Echantillonnage" {
            include *
        }
        container ssinsp "DiagramLevel2Inspections" {
            include *
        }
        container ssrepg "DiagramLevel2RepG" {
            include *
        }
        container ssgae "DiagramLevel2GAE" {
            include *
        }

        component of "VuesDesFormulairesOracle" {
            include *
            autoLayout tb
            description "Vues Oracle dans GAE"
        }

        # Vue contexte système
        systemContext reqSystem "SystemContext" {
            include *
            autoLayout tb
            description "Vue contextuelle du système REQ et ses intégrations"
        }

        systemContext powerPlatformSystem "FSSystemContext" {
            include *
            exclude fsMobile
            description "Vue contextuelle de Microsoft Field Service"
        }

        # Vue conteneurs Permit
        container reqSystem "SAOEPermitContainers" {
            include *
            description "Architecture conteneurs du système SAOE Permis"
        }

        # Vue conteneurs Field Service
        container powerPlatformSystem "FSContainers" {
            include *
            exclude fsMobile
            description "Architecture conteneurs de Field Service"
        }

        # Vue conteneurs Field Service
        dynamic powerPlatformSystem "InspectionFlow" {
            #inspecteur -> fsMobile "Effectue les activités sur le terrain " "HTTPS"
            inspecteur -> saoeWeb "Modifie la planification" "HTTPS"
            repartiteur -> saoeWeb "Planifie le travail" "HTTPS"
            powerAutomate -> dataverse "Crée/Met à jour entités" "Dataverse Web API"
            dataverse -> sharePoint "Contient les documents sur les entreprises et établissement" "SharePoint REST API"
            #fsMobile -> dataverse "Synchronise données" "Dataverse Offline Sync"
            #dataverse -> fsMobile "Envoie mises à jour" "Dataverse Offline Sync"
            saoeWeb -> dataverse "CRUD opérations" "Dataverse Web API"
            autoLayout tb
        }

        # Vue composants API Node.js
        #component nodeAPI "NodeAPIComponents" {
        #    include *
        #    autoLayout lr
        #    description "Composants de l'API Node.js REQ"
        #}

        # Vue composants Sync Worker
        #component syncWorker "SyncWorkerComponents" {
        #    include *
        #    autoLayout tb
        #    description "Composants du worker de synchronisation"
        #}

        # Vue composants Dataverse
        component dataverse "DataverseComponents" {
            include *
            autoLayout tb
            description "Tables custom Dataverse pour REQ et Plaintes"
        }

        # Vue composants Field Service Mobile
        #component fsMobile "FSMobileComponents" {
        #    include *
        #    autoLayout tb
        #    description "Composants Field Service Mobile"
        #}

        # Vue flux de synchronisation
        dynamic reqSystem "SynchronizationFlow" "Flux de synchronisation REQ vers Field Service" {
            organization -> angularCitizenApp "soumet une demande"
            angularCitizenApp -> nodeAPI "POST ../submission"
            nodeAPI -> postgresql "CREATE/UPDATE/READ tables"
            syncWorker -> postgresql "Synchronise"
            syncWorker -> sqs "Queue message"
            syncWorker -> dataverse "POST $batch"
            syncWorker -> stepfunction "ack"
            powerAutomate -> dataverse "8. Upsert account"
            powerAutomate -> nodeAPI "récupère les données/notifie des changements (accounts, contacts, emplacements) ou GDE??????"
            dataverse -> fsMobile "9. Offline sync (prochaine connexion)"
            dataverse -> nodeAPI "notifie lors du changement de statut (webhooks)" "HTTPS"
            autoLayout tb
        }

        # --- Flux entreprise ---
        dynamic powerPlatformSystem "EnterpriseFlow" "Flux de gestion des entreprises" {
            employeeVille -> saoeWeb "Saisie un nouvel établissement (Module Entreprise)"
            employeeVille -> saoeWeb "Met à jour une adresse, un contact d'un établissement"
            employeeVille -> saoeWeb "Consulte les données reliées à l'établissement"
            inspecteur -> saoeWeb "Consulte les données reliées à l'établissement"
            #inspecteur -> fsMobile "Consulte les données reliées à l'établissement"
            #inspecteur -> fsMobile "Met à jour une adresse, un contact d'un établissement"
            saoeWeb -> dataverse "Crée/Met à jour un Compte (via API)"
            powerAutomate -> dataverse "Déclenche flux pour obtenir les données du REQ (sur création)"
            #dataverse -> fsMobile "Envoie mises à jour (Sync Offline)"
        }

        # --- Flux plainte ---
        dynamic powerPlatformSystem "IncidentFlow" "Flux de gestion d'une plainte" {
            employeeVille -> saoeWeb "Saisie nouvelle plainte (Module Plainte)"
            saoeWeb -> dataverse "Crée incident (via API)"
            powerAutomate -> dataverse "Déclenche flux SLA (sur création)"
            powerAutomate -> inspecteur "Notifie réception (Courriel)"
            inspecteur -> saoeWeb "Consulte les données de la plainte"
            #dataverse -> fsMobile "Envoie mises à jour (Sync Offline)"
            #inspecteur -> fsMobile "Consulte la plainte"
            #fsMobile -> dataverse "Synchronise les données (Online)"
        }

        # Vue flux mobile offline
        dynamic powerPlatformSystem "MobileOfflineFlow" "Flux utilisation mobile offline" {
            inspecteur -> fsMobile "1. Ouvre app mobile (mode offline)"
            inspecteur -> fsMobile "2. Consulte entreprises/bâtiments (cache local SQLite)"
            inspecteur -> fsMobile "4. Crée/modifie ordre de travail (sauvegarde locale)"
            inspecteur -> fsMobile "5. Se reconnecte au réseau WiFi/4G"
            fsMobile -> dataverse "6. Synchronisation bidirectionnelle des données"
            dataverse -> fsMobile "7. Télécharge nouvelles données et documents"
            fsMobile -> inspecteur "8. Notifie synchronisation terminée"
            autoLayout lr
        }

        #Vue infrastructure Azure
        container azureInfraSystem "AzureObservabilityFlow" "Flux utilisation TI" {
            include *
            autoLayout lr
        }

        container montrealInfraSystem "VilleObservabilityFlow" "Flux utilisation TI" {
            include *
            autoLayout lr
        }

        component appInsights "ObservabilityFlow" "Flux utilisation TI" {
            include *
            autoLayout lr
        }

        # Styles
        styles {
            element "Person" {
                shape Person
                background #08427b
                color #ffffff
            }
            element "Utilisateur" {
                background #08427b
            }
            element "Admin" {
                background #999999
            }
            element "External" {
                background #999999
                color #ffffff
            }
            element "Database" {
                shape Cylinder
                background #438dd5
                color #ffffff
            }
            element "Queue" {
                shape Pipe
                background #ff6b6b
                color #ffffff
            }
            element "Storage" {
                shape Folder
                background #feca57
                color #000000
            }
            element "Web Browser" {
                shape WebBrowser
                background #0abde3
                color #ffffff
            }
            element "Mobile" {
                shape MobileDevicePortrait
                background #0abde3
                color #ffffff
            }
            element "API" {
                background #ee5a6f
                color #ffffff
            }
            element "Worker" {
                background #c44569
                color #ffffff
            }
            element "PaaS" {
                background #00d2d3
                color #ffffff
            }
            element "Model-driven App Module" {
                shape WebBrowser
                background #2d8cff
                color #ffffff
            }
        }

        themes https://static.structurizr.com/themes/microsoft-azure-2023.01.24/theme.json
    }

}
