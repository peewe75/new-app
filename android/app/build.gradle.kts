import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Firma: con la chiave dello studio (segreti di GitHub) se presente, altrimenti con la chiave di debug.
val keystoreFile: String? = System.getenv("SEGUITO_KEYSTORE_FILE")
val buildNumber: Int = System.getenv("SEGUITO_VERSION_CODE")?.toIntOrNull() ?: 1

android {
    namespace = "it.seguito.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "it.seguito.app"
        minSdk = 31
        targetSdk = 36
        versionCode = buildNumber
        versionName = "0.1.$buildNumber"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (keystoreFile != null) {
            create("studio") {
                storeFile = file(keystoreFile)
                storePassword = System.getenv("SEGUITO_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SEGUITO_KEY_ALIAS")
                keyPassword = System.getenv("SEGUITO_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("studio") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.10.01")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.work:work-runtime-ktx:2.10.5")
    testImplementation("junit:junit:4.13.2")

    androidTestImplementation(composeBom)
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
